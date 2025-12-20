/**
 * Installation script for Happy daemon using macOS LaunchDaemons
 * 
 * NOTE: This installation method is currently NOT USED in favor of auto-starting 
 * the daemon when the user runs the happy command. 
 * 
 * Why we're not using this approach:
 * 1. Installing a LaunchDaemon requires sudo permissions, which users might not be comfortable with
 * 2. We assume users will run happy frequently (every time they open their laptop)
 * 3. The auto-start approach provides the same functionality without requiring elevated permissions
 * 
 * This code is kept for potential future use if we decide to offer system-level installation as an option.
 */

import { writeFileSync, chmodSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { logger } from '@/ui/logger';
import os from 'os';
import plist from 'plist';

const PLIST_LABEL = 'com.happy-cli.daemon';
const PLIST_FILE = `/Library/LaunchDaemons/${PLIST_LABEL}.plist`;

// NOTE: Local installation like --local does not make too much sense I feel like

export async function install(): Promise<void> {
    try {
        // Check if already installed
        if (existsSync(PLIST_FILE)) {
            logger.info('Daemon plist already exists. Uninstalling first...');
            execSync(`launchctl unload ${PLIST_FILE}`, { stdio: 'inherit' });
        }

        // Get the path to the happy CLI executable
        const happyPath = process.argv[0]; // Node.js executable
        const scriptPath = process.argv[1]; // Script path

        // Create plist data structure
        const plistData = {
            Label: PLIST_LABEL,
            ProgramArguments: [happyPath, scriptPath, 'happy-daemon'],
            EnvironmentVariables: {
                HAPPY_DAEMON_MODE: 'true'
            },
            RunAtLoad: true,
            KeepAlive: true,
            StandardErrorPath: `${os.homedir()}/.enfm-happy/daemon.err`,
            StandardOutPath: `${os.homedir()}/.enfm-happy/daemon.log`,
            WorkingDirectory: '/tmp'
        };

        // Generate plist content using plist library
        const plistContent = plist.build(plistData);

        // Write plist file
        writeFileSync(PLIST_FILE, plistContent);
        chmodSync(PLIST_FILE, 0o644);

        logger.info(`Created daemon plist at ${PLIST_FILE}`);

        // Load the daemon
        execSync(`launchctl load ${PLIST_FILE}`, { stdio: 'inherit' });

        logger.info('Daemon installed and started successfully');
        logger.info('Check logs at ~/.enfm-happy/daemon.log');

    } catch (error) {
        logger.debug('Failed to install daemon:', error);
        throw error;
    }
}