import fs from 'fs/promises';
import path from 'path';
import { WorkDir } from '../../config/config.js';
import { AppleCalendarConfig } from './types.js';

export interface IAppleCalendarConfigRepo {
    getConfig(): Promise<AppleCalendarConfig>;
    setConfig(config: AppleCalendarConfig): Promise<void>;
}

export class FSAppleCalendarConfigRepo implements IAppleCalendarConfigRepo {
    private readonly configPath = path.join(WorkDir, 'config', 'apple_calendar.json');
    private readonly defaultConfig: AppleCalendarConfig = { enabled: false };

    constructor() {
        this.ensureConfigFile();
    }

    private async ensureConfigFile(): Promise<void> {
        try {
            await fs.access(this.configPath);
        } catch {
            // File doesn't exist, create it with default config
            await fs.writeFile(this.configPath, JSON.stringify(this.defaultConfig, null, 2));
        }
    }

    async getConfig(): Promise<AppleCalendarConfig> {
        try {
            const content = await fs.readFile(this.configPath, 'utf8');
            const parsed = JSON.parse(content);
            return AppleCalendarConfig.parse(parsed);
        } catch {
            // If file doesn't exist or is invalid, return default
            return this.defaultConfig;
        }
    }

    async setConfig(config: AppleCalendarConfig): Promise<void> {
        // Validate before saving
        const validated = AppleCalendarConfig.parse(config);
        await fs.writeFile(this.configPath, JSON.stringify(validated, null, 2));
    }
}
