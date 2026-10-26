import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { env } from "./env.js";

const isLocalDb = /localhost|127\.0\.0\.1/.test(env.DATABASE_URL);

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  ssl: isLocalDb ? false : { rejectUnauthorized: false }, // RDS / hosted Postgres
});

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

export default prisma;
