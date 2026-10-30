import {sqliteTable, integer, text} from 'drizzle-orm/sqlite-core';
export const state = sqliteTable('starpunch_state', { id: integer('id').primaryKey(), revision: integer('revision').notNull(), payload: text('payload').notNull() });
export const backups = sqliteTable('starpunch_backups', { day: text('day').primaryKey(), payload: text('payload').notNull() });
