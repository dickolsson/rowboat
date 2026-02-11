import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { WorkDir } from '../config/config.js';
import { serviceLogger, type ServiceRunContext } from '../services/service_logger.js';
import { limitEventItems } from './limit_event_items.js';

/**
 * macOS Mail Sync Module
 * 
 * Reads email data from the local macOS Mail SQLite database and syncs it to markdown files.
 * 
 * Database location: ~/Library/Mail/V*/MailData/Envelope Index
 * 
 * IMPORTANT PRIVACY NOTE:
 * - macOS Sequoia+ may require "Full Disk Access" permission to read from ~/Library/Mail
 * - This integration reads data locally only (no iCloud API)
 * - Opens database in read-only mode to prevent any corruption
 */

// Configuration
const SYNC_DIR = path.join(WorkDir, 'apple_mail_sync');
const STATE_FILE = path.join(SYNC_DIR, 'sync_state.json');
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const LOOKBACK_DAYS = 30; // Sync last 30 days of messages
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds

// --- Wake Signal for Immediate Sync Trigger ---
let wakeResolve: (() => void) | null = null;

export function triggerSync(): void {
    if (wakeResolve) {
        console.log('[Apple Mail] Triggered - waking up immediately');
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
 * Find the Mail database path by scanning for the latest version folder
 * Returns null if not found or not on macOS
 */
function findMailDatabasePath(): string | null {
    if (!isMacOS()) {
        return null;
    }

    const mailLibraryPath = path.join(homedir(), 'Library', 'Mail');
    
    if (!fs.existsSync(mailLibraryPath)) {
        console.log('[Apple Mail] Mail library not found at:', mailLibraryPath);
        return null;
    }

    try {
        // Find all V* directories (e.g., V10, V11, V12)
        const entries = fs.readdirSync(mailLibraryPath);
        const versionDirs = entries.filter(entry => /^V\d+$/.test(entry));
        
        if (versionDirs.length === 0) {
            console.log('[Apple Mail] No version directories found');
            return null;
        }

        // Sort by version number (descending) to get the latest
        versionDirs.sort((a, b) => {
            const aNum = parseInt(a.substring(1));
            const bNum = parseInt(b.substring(1));
            return bNum - aNum;
        });

        // Check each version directory for the Envelope Index
        for (const versionDir of versionDirs) {
            const dbPath = path.join(mailLibraryPath, versionDir, 'MailData', 'Envelope Index');
            if (fs.existsSync(dbPath)) {
                console.log('[Apple Mail] Found database at:', dbPath);
                return dbPath;
            }
        }

        console.log('[Apple Mail] Envelope Index not found in any version directory');
        return null;
    } catch (error) {
        console.error('[Apple Mail] Error scanning for database:', error);
        return null;
    }
}

// --- State Management ---

interface SyncState {
    lastSyncTimestamp: number;
    lastSyncDate: string;
    processedMessageIds: string[];
}

function loadState(): SyncState {
    if (fs.existsSync(STATE_FILE)) {
        try {
            const content = fs.readFileSync(STATE_FILE, 'utf-8');
            return JSON.parse(content);
        } catch {
            return { lastSyncTimestamp: 0, lastSyncDate: '', processedMessageIds: [] };
        }
    }
    return { lastSyncTimestamp: 0, lastSyncDate: '', processedMessageIds: [] };
}

function saveState(state: SyncState): void {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Helper Functions ---

function cleanFilename(name: string): string {
    return name.replace(/[\\/*?:"<>|]/g, "").substring(0, 100).trim();
}

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

interface EmailMessage {
    message_id: number;
    subject: string;
    sender: string;
    recipients: string;
    date_received: number;
    body: string;
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
                console.log(`[Apple Mail] Database locked, attempt ${attempt}/${MAX_RETRIES}`);
                if (attempt < MAX_RETRIES) {
                    await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
                    continue;
                }
            }
            
            console.error('[Apple Mail] Failed to open database:', error);
            return null;
        }
    }
    return null;
}

/**
 * Query messages from the database
 * Note: The actual schema may vary by macOS version. This is a simplified query.
 */
function queryMessages(db: Database.Database, sinceTimestamp: number): EmailMessage[] {
    try {
        // The Mail database schema includes tables like:
        // - messages (main message table)
        // - addresses (sender/recipient addresses)
        // - subjects (email subjects)
        // - message_data (email body content)
        
        // This is a simplified query - the actual schema is more complex
        // and may require joining multiple tables
        const stmt = db.prepare(`
            SELECT 
                m.ROWID as message_id,
                COALESCE(s.subject, '(No Subject)') as subject,
                COALESCE(a.address, 'Unknown') as sender,
                m.date_received,
                COALESCE(md.data, '') as body
            FROM messages m
            LEFT JOIN subjects s ON m.subject = s.ROWID
            LEFT JOIN addresses a ON m.sender = a.ROWID
            LEFT JOIN message_data md ON m.ROWID = md.message_id
            WHERE m.date_received > ?
            ORDER BY m.date_received DESC
            LIMIT 1000
        `);
        
        const rows = stmt.all(sinceTimestamp) as EmailMessage[];
        return rows;
    } catch (error) {
        console.error('[Apple Mail] Error querying messages:', error);
        // If the query fails (schema mismatch), return empty array
        return [];
    }
}

// --- Sync Logic ---

/**
 * Convert email message to markdown format
 */
function messageToMarkdown(message: EmailMessage): string {
    const subject = message.subject || '(No Subject)';
    const sender = message.sender || 'Unknown';
    const date = new Date(message.date_received * 1000).toISOString();
    const body = message.body || '';

    let md = `# ${subject}\n\n`;
    md += `**Message ID:** ${message.message_id}\n`;
    md += `**From:** ${sender}\n`;
    md += `**Date:** ${date}\n\n`;
    md += `---\n\n`;
    md += `${body}\n\n`;

    return md;
}

/**
 * Perform the sync operation
 */
async function performSync(): Promise<void> {
    if (!isMacOS()) {
        console.log('[Apple Mail] Skipping sync - not running on macOS');
        return;
    }

    console.log('[Apple Mail] Starting sync...');

    let run: ServiceRunContext | null = null;
    const ensureRun = async () => {
        if (!run) {
            run = await serviceLogger.startRun({
                service: 'apple_mail',
                message: 'Syncing Apple Mail',
                trigger: 'timer',
            });
        }
    };

    try {
        // Find database path
        const dbPath = findMailDatabasePath();
        if (!dbPath) {
            console.log('[Apple Mail] Mail database not found - is Mail.app installed?');
            return;
        }

        // Ensure sync directory exists
        ensureDir(SYNC_DIR);

        // Load state
        const state = loadState();

        // Calculate lookback timestamp
        const lookbackTimestamp = Math.floor((Date.now() - (LOOKBACK_DAYS * 24 * 60 * 60 * 1000)) / 1000);
        const sinceTimestamp = state.lastSyncTimestamp || lookbackTimestamp;

        console.log(`[Apple Mail] Syncing messages since ${new Date(sinceTimestamp * 1000).toISOString()}`);

        // Open database with retry logic
        const db = await openDatabaseWithRetry(dbPath);
        if (!db) {
            console.log('[Apple Mail] Could not open database (may be locked by Mail.app)');
            return;
        }

        try {
            // Query messages
            const messages = queryMessages(db, sinceTimestamp);
            
            if (messages.length === 0) {
                console.log('[Apple Mail] No new messages to sync');
                return;
            }

            console.log(`[Apple Mail] Found ${messages.length} messages to sync`);
            await ensureRun();

            const messageTitles: string[] = [];
            let syncedCount = 0;

            // Process each message
            for (const message of messages) {
                const markdown = messageToMarkdown(message);
                const filename = `${message.message_id}_${cleanFilename(message.subject)}.md`;
                const filePath = path.join(SYNC_DIR, filename);

                fs.writeFileSync(filePath, markdown);
                messageTitles.push(message.subject);
                syncedCount++;

                console.log(`[Apple Mail] Synced: ${filename}`);
            }

            // Update state
            state.lastSyncTimestamp = Math.floor(Date.now() / 1000);
            state.lastSyncDate = new Date().toISOString();
            saveState(state);

            if (run) {
                const limitedTitles = limitEventItems(messageTitles);
                await serviceLogger.log({
                    type: 'changes_identified',
                    service: run.service,
                    runId: run.runId,
                    level: 'info',
                    message: `Found ${syncedCount} new message${syncedCount === 1 ? '' : 's'}`,
                    counts: { messages: syncedCount },
                    items: limitedTitles.items,
                    truncated: limitedTitles.truncated,
                });

                await serviceLogger.log({
                    type: 'run_complete',
                    service: run.service,
                    runId: run.runId,
                    level: 'info',
                    message: `Apple Mail sync complete: ${syncedCount} message${syncedCount === 1 ? '' : 's'}`,
                    durationMs: Date.now() - run.startedAt,
                    outcome: 'ok',
                    summary: { messages: syncedCount },
                });
            }

            console.log(`[Apple Mail] Sync complete: ${syncedCount} messages`);

        } finally {
            db.close();
        }

    } catch (error) {
        console.error('[Apple Mail] Error during sync:', error);
        if (run) {
            await serviceLogger.log({
                type: 'error',
                service: run.service,
                runId: run.runId,
                level: 'error',
                message: 'Apple Mail sync error',
                error: error instanceof Error ? error.message : String(error),
            });
            await serviceLogger.log({
                type: 'run_complete',
                service: run.service,
                runId: run.runId,
                level: 'error',
                message: 'Apple Mail sync failed',
                durationMs: Date.now() - run.startedAt,
                outcome: 'error',
            });
        }
    }
}

// --- Main Loop ---

export async function init(): Promise<void> {
    if (!isMacOS()) {
        console.log('[Apple Mail] Skipping initialization - not running on macOS');
        return;
    }

    console.log('[Apple Mail] Starting Apple Mail Sync...');
    console.log(`[Apple Mail] Will sync every ${SYNC_INTERVAL_MS / 60000} minutes`);
    console.log(`[Apple Mail] Syncing last ${LOOKBACK_DAYS} days of messages`);

    while (true) {
        try {
            await performSync();
        } catch (error) {
            console.error('[Apple Mail] Error in main loop:', error);
        }

        // Sleep for interval (can be interrupted by triggerSync)
        console.log(`[Apple Mail] Sleeping for ${SYNC_INTERVAL_MS / 60000} minutes...`);
        await interruptibleSleep(SYNC_INTERVAL_MS);
    }
}
