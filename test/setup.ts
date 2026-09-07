// Minimal env so config.ts loads in tests without a real .env
process.env.USER_WHATSAPP_NUMBER ??= "+972500000000";
process.env.GOOGLE_CLIENT_ID ??= "test";
process.env.GOOGLE_CLIENT_SECRET ??= "test";
process.env.WHATSAPP_PROVIDER ??= "console";
process.env.TIMEZONE ??= "Asia/Jerusalem";
process.env.DATABASE_PATH ??= ":memory:";
process.env.LOG_LEVEL ??= "error";
