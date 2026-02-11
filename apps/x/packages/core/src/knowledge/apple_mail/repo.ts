import fs from 'fs/promises';
import path from 'path';
import { WorkDir } from '../../config/config.js';
import { AppleMailConfig } from './types.js';

export interface IAppleMailConfigRepo {
    getConfig(): Promise<AppleMailConfig>;
    setConfig(config: AppleMailConfig): Promise<void>;
}

export class FSAppleMailConfigRepo implements IAppleMailConfigRepo {
    private readonly configPath = path.join(WorkDir, 'config', 'apple_mail.json');
    private readonly defaultConfig: AppleMailConfig = { enabled: false };

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

    async getConfig(): Promise<AppleMailConfig> {
        try {
            const content = await fs.readFile(this.configPath, 'utf8');
            const parsed = JSON.parse(content);
            return AppleMailConfig.parse(parsed);
        } catch {
            // If file doesn't exist or is invalid, return default
            return this.defaultConfig;
        }
    }

    async setConfig(config: AppleMailConfig): Promise<void> {
        // Validate before saving
        const validated = AppleMailConfig.parse(config);
        await fs.writeFile(this.configPath, JSON.stringify(validated, null, 2));
    }
}
