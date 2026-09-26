import { existsSync } from 'node:fs';
import { DataSource } from 'typeorm';
import { validateEnv } from '../config/env.validation';
import { buildTypeOrmOptions } from './typeorm.options';

// Used by the TypeORM CLI and the migration/seed scripts, which run outside Nest.
// Locally the values come from .env; in Docker they come from the container env.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default new DataSource(buildTypeOrmOptions(validateEnv(process.env)));
