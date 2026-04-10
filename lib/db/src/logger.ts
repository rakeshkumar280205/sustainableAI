/**
 * Simple logger for database module.
 * Emits JSON lines to standard output/error to avoid circular dependencies.
 */

function write(level: string, message: string, meta?: Record<string, unknown>): void {
    const payload = {
        level,
        message,
        ...(meta ?? {}),
    };

    const line = `${JSON.stringify(payload)}\n`;
    if (level === "error") {
        process.stderr.write(line);
        return;
    }

    process.stdout.write(line);
}

export const logger = {
    info: (msg: string, meta?: Record<string, unknown>) => {
        write("info", msg, meta);
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
        write("warn", msg, meta);
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
        write("error", msg, meta);
    },
};
