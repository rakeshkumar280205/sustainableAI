import "dotenv/config";

export interface DbConfig {
    mongodbUri: string | null;
    databaseUrl: string | null;
}

function getEnvironmentVariable(name: string): string | undefined {
    return process.env[name];
}

export const dbConfig: DbConfig = {
    mongodbUri: getEnvironmentVariable("MONGODB_URI") ?? null,
    databaseUrl: getEnvironmentVariable("DATABASE_URL") ?? null,
};
