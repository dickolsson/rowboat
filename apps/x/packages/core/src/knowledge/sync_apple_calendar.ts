import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { WorkDir } from '../config/config.js';
import { serviceLogger, type ServiceRunContext } from '../services/service_logger.js';
import { limitEventItems } from './limit_event_items.js';

/**
 * macOS Calendar Sync Module
 * 
 * Reads calendar events from the local macOS Calendar SQLite database and syncs them to JSON files.
 * 
 * Database location: ~/Library/Calendars/Calendar.sqlitedb
 * 
 * IMPORTANT PRIVACY NOTE:
 * - macOS Sequoia+ may require "Full Disk Access" permission to read from ~/Library/Calendars
 * - This integration reads data locally only (no iCloud API)
 * - Opens database in read-only mode to prevent any corruption
 */

// Configuration
const SYNC_DIR = path.join(WorkDir, 'apple_calendar_sync');
const STATE_FILE = path.join(SYNC_DIR, 'sync_state.json');
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const LOOKBACK_DAYS = 14; // Sync events from 14 days ago
const FORWARD_DAYS = 14; // Sync events up to 14 days forward
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds

// --- Wake Signal for Immediate Sync Trigger ---
let wakeResolve: (() => void) | null = null;

export function triggerSync(): void {
    if (wakeResolve) {
        console.log('[Apple Calendar] Triggered - waking up immediately');
        wakeResolve();
        wakeResolve = null;
    }
}

function interruptibleSleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            wakeResolve = null;
            resolve();
        }, ms);
        wakeResolve = () => {
            clearTimeout(timeout);
            resolve();
        };
    });
}

// --- Platform Check ---

function isMacOS(): boolean {
    return process.platform === 'darwin';
}

// --- Database Path Discovery ---

/**
 * Find the Calendar database path
 * Returns null if not found or not on macOS
 */
function findCalendarDatabasePath(): string | null {
    if (!isMacOS()) {
        return null;
    }

    const calendarDbPath = path.join(homedir(), 'Library', 'Calendars', 'Calendar.sqlitedb');
    
    if (!fs.existsSync(calendarDbPath)) {
        console.log('[Apple Calendar] Calendar database not found at:', calendarDbPath);
        return null;
    }

    console.log('[Apple Calendar] Found database at:', calendarDbPath);
    return calendarDbPath;
}

// --- State Management ---

interface SyncState {
    lastSyncTimestamp: number;
    lastSyncDate: string;
}

function loadState(): SyncState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const content = fs.readFileSync(STATE_FILE, 'utf-8');
            return JSON.parse(content);
        } catch {
            return { lastSyncTimestamp: 0, lastSyncDate: '' };
        }
    }
    return { lastSyncTimestamp: 0, lastSyncDate: '' };
}

function saveState(state: SyncState): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Helper Functions ---

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Sleep with exponential backoff
 */
async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Database Operations ---

interface CalendarEvent {
    id: string;
    summary: string;
    startDate: number;
    endDate: number;
    location: string | null;
    description: string | null;
    organizer: string | null;
    attendees: string[];
}

/**
 * Convert Core Data timestamp to JavaScript Date
 * Core Data uses reference date of 2001-01-01
 */
function coreDataTimestampToDate(timestamp: number): Date {
    const referenceDate = new Date('2001-01-01T00:00:00Z').getTime();
    return new Date(referenceDate + timestamp * 1000);
}

/**
 * Open database with retry logic for handling locks
 */
async function openDatabaseWithRetry(dbPath: string): Promise<Database.Database | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Open in read-only mode to prevent any corruption
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            return db;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            if (errorMessage.includes('SQLITE_BUSY') || errorMessage.includes('database is locked')) {
                console.log(`[Apple Calendar] Database locked, attempt ${attempt}/${MAX_RETRIES}`);
                if (attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
                    continue;
                }
            }
            
            console.error('[Apple Calendar] Failed to open database:', error);
            return null;
        }
    }
    return null;
}

/**
 * Query calendar events from the database
 * Note: The Calendar database uses Core Data with a complex schema
 */
function queryEvents(db: Database.Database, startTimestamp: number, endTimestamp: number): CalendarEvent[] {
    try {
        // The Calendar database schema includes:
        // - ZCALENDARITEM (main event table, Z_PK is primary key)
        // - ZCALENDAR (calendar information)
        // - ZATTENDEE (event attendees)
        // - ZPARTICIPANT (organizer and participants)
        
        // Core Data uses timestamps relative to 2001-01-01
        const referenceDate = new Date('2001-01-01T00:00:00Z').getTime() / 1000;
        const coreDataStart = startTimestamp - referenceDate;
        const coreDataEnd = endTimestamp - referenceDate;
        
        const stmt = db.prepare(`
            SELECT 
                ci.Z_PK as id,
                ci.ZTITLE as summary,
                ci.ZSTARTDATE as startDate,
                ci.ZENDDATE as endDate,
                ci.ZLOCATION as location,
                ci.ZNOTES as description,
                ci.ZORGANIZER as organizer
            FROM ZCALENDARITEM ci
            WHERE ci.ZSTARTDATE >= ? AND ci.ZSTARTDATE <= ?
            ORDER BY ci.ZSTARTDATE DESC
            LIMIT 1000
        `);
        
        const rows = stmt.all(coreDataStart, coreDataEnd) as any[];
        
        // Convert to CalendarEvent format
        const events: CalendarEvent[] = rows.map(row => ({
            id: String(row.id),
            summary: row.summary || 'Untitled Event',
            startDate: row.startDate,
            endDate: row.endDate,
            location: row.location || null,
            description: row.description || null,
            organizer: row.organizer || null,
            attendees: [], // Would need to join with ZATTENDEE table
        }));
        
        return events;
    } catch (error) {
        console.error('[Apple Calendar] Error querying events:', error);
        // If the query fails (schema mismatch), return empty array
        return [];
    }
}

// --- Sync Logic ---

/**
 * Convert calendar event to JSON format (matching Google Calendar format)
 */
function eventToJSON(event: CalendarEvent): object {
    const startDate = coreDataTimestampToDate(event.startDate);
    const endDate = coreDataTimestampToDate(event.endDate);

    return {
        id: event.id,
        summary: event.summary,
        start: {
            dateTime: startDate.toISOString(),
        },
        end: {
            dateTime: endDate.toISOString(),
        },
        location: event.location || undefined,
        description: event.description || undefined,
        organizer: event.organizer ? { email: event.organizer } : undefined,
        attendees: event.attendees.length > 0 
            ? event.attendees.map(email => ({ email }))
            : undefined,
    };
}

/**
 * Clean up old event files that are no longer in the sync window
 */
function cleanUpOldFiles(currentEventIds: Set<string>, syncDir: string): string[] {
    if (!fs.existsSync(syncDir)) return [];

    const files = fs.readdirSync(syncDir);
    const deleted: string[] = [];
    
    for (const filename of files) {
        if (filename === 'sync_state.json') continue;

        // We expect files like: {eventId}.json
        if (filename.endsWith('.json')) {
            const eventId = filename.replace('.json', '');
            
            if (!currentEventIds.has(eventId)) {
                try {
                    fs.unlinkSync(path.join(syncDir, filename));
                    console.log(`[Apple Calendar] Removed old file: ${filename}`);
                    deleted.push(filename);
                } catch (e) {
                    console.error(`[Apple Calendar] Error deleting file ${filename}:`, e);
                }
            }
        }
    }
    
    return deleted;
}

/**
 * Perform the sync operation
 */
async function performSync(): Promise<void> {
    if (!isMacOS()) {
        console.log('[Apple Calendar] Skipping sync - not running on macOS');
        return;
    }

    console.log('[Apple Calendar] Starting sync...');

    let run: ServiceRunContext | null = null;
    const ensureRun = async () => {
        if (!run) {
            run = await serviceLogger.startRun({
                service: 'apple_calendar',
                message: 'Syncing Apple Calendar',
                trigger: 'timer',
            });
        }
    };

    try {
        // Find database path
        const dbPath = findCalendarDatabasePath();
        if (!dbPath) {
            console.log('[Apple Calendar] Calendar database not found - is Calendar.app installed?');
            return;
        }

        // Ensure sync directory exists
        ensureDir(SYNC_DIR);

        // Load state
        const state = loadState();

        // Calculate time window (in seconds since epoch)
        const now = Math.floor(Date.now() / 1000);
        const startTimestamp = now - (LOOKBACK_DAYS * 24 * 60 * 60);
        const endTimestamp = now + (FORWARD_DAYS * 24 * 60 * 60);

        console.log(`[Apple Calendar] Syncing events from ${new Date(startTimestamp * 1000).toISOString()} to ${new Date(endTimestamp * 1000).toISOString()}`);

        // Open database with retry logic
        const db = await openDatabaseWithRetry(dbPath);
        if (!db) {
            console.log('[Apple Calendar] Could not open database (may be locked by Calendar.app)');
            return;
        }

        try {
            // Query events
            const events = queryEvents(db, startTimestamp, endTimestamp);
            
            console.log(`[Apple Calendar] Found ${events.length} events in sync window`);

            const currentEventIds = new Set<string>();
            const eventTitles: string[] = [];
            let newCount = 0;
            let updatedCount = 0;

            // Process each event
            for (const event of events) {
                currentEventIds.add(event.id);

                const json = eventToJSON(event);
                const filename = `${event.id}.json`;
                const filePath = path.join(SYNC_DIR, filename);

                const content = JSON.stringify(json, null, 2);
                const exists = fs.existsSync(filePath);

                try {
                    if (exists) {
                        const existing = fs.readFileSync(filePath, 'utf-8');
                        if (existing === content) {
                            continue; // No changes
                        }
                        updatedCount++;
                    } else {
                        newCount++;
                    }

                    fs.writeFileSync(filePath, content);
                    eventTitles.push(event.summary);
                    console.log(`[Apple Calendar] ${exists ? 'Updated' : 'Saved'}: ${filename}`);
                } catch (e) {
                    console.error(`[Apple Calendar] Error saving event ${event.id}:`, e);
                }
            }

            // Clean up old files
            const deletedFiles = cleanUpOldFiles(currentEventIds, SYNC_DIR);
            const deletedCount = deletedFiles.length;

            if (newCount > 0 || updatedCount > 0 || deletedCount > 0) {
                await ensureRun();

                const totalChanges = newCount + updatedCount + deletedCount;
                const limitedTitles = limitEventItems(eventTitles);

                await serviceLogger.log({
                    type: 'changes_identified',
                    service: run!.service,
                    runId: run!.runId,
                    level: 'info',
                    message: `Calendar updates: ${totalChanges} change${totalChanges === 1 ? '' : 's'}`,
                    counts: {
                        newEvents: newCount,
                        updatedEvents: updatedCount,
                        deletedFiles: deletedCount,
                    },
                    items: limitedTitles.items,
                    truncated: limitedTitles.truncated,
                });

                await serviceLogger.log({
                    type: 'run_complete',
                    service: run!.service,
                    runId: run!.runId,
                    level: 'info',
                    message: `Apple Calendar sync complete: ${totalChanges} change${totalChanges === 1 ? '' : 's'}`,
                    durationMs: Date.now() - run!.startedAt,
                    outcome: 'ok',
                    summary: {
                        newEvents: newCount,
                        updatedEvents: updatedCount,
                        deletedFiles: deletedCount,
                    },
                });

                console.log(`[Apple Calendar] Sync complete: ${newCount} new, ${updatedCount} updated, ${deletedCount} deleted`);
            } else {
                console.log('[Apple Calendar] No changes detected');
            }

            // Update state
            state.lastSyncTimestamp = Math.floor(Date.now() / 1000);
            state.lastSyncDate = new Date().toISOString();
            saveState(state);

        } finally {
            db.close();
        }

    } catch (error) {
        console.error('[Apple Calendar] Error during sync:', error);
        if (run) {
            await serviceLogger.log({
                type: 'error',
                service: run.service,
                runId: run.runId,
                level: 'error',
                message: 'Apple Calendar sync error',
                error: error instanceof Error ? error.message : String(error),
            });
            await serviceLogger.log({
                type: 'run_complete',
                service: run.service,
                runId: run.runId,
                level: 'error',
                message: 'Apple Calendar sync failed',
                durationMs: Date.now() - run.startedAt,
                outcome: 'error',
            });
        }
    }
}

// --- Main Loop ---

export async function init(): Promise<void> {
    if (!isMacOS()) {
        console.log('[Apple Calendar] Skipping initialization - not running on macOS');
        return;
    }

    console.log('[Apple Calendar] Starting Apple Calendar Sync...');
    console.log(`[Apple Calendar] Will sync every ${SYNC_INTERVAL_MS / 60000} minutes`);
    console.log(`[Apple Calendar] Syncing events from ${LOOKBACK_DAYS} days ago to ${FORWARD_DAYS} days forward`);

    while (true) {
        try {
            await performSync();
        } catch (error) {
            console.error('[Apple Calendar] Error in main loop:', error);
        }

        // Sleep for interval (can be interrupted by triggerSync)
        console.log(`[Apple Calendar] Sleeping for ${SYNC_INTERVAL_MS / 60000} minutes...`);
        await interruptibleSleep(SYNC_INTERVAL_MS);
    }
}
