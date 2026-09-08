use crate::error::Result;
use crate::host::api::PersistenceProvider;
use async_trait::async_trait;
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::sync::Arc;

/// Shared KV for bot state.
///
/// WARNING (pre-wiring debt): `bot_kv` has NO bot_id column — every bot
/// sharing this file can read and overwrite every other bot's keys. Harmless
/// while nothing executes; a data-leak footgun the moment the runtime is
/// wired. Fix = add a bot_id column + namespace prefixing in the same
/// migration that attaches real callers.
pub struct SqlitePersistence {
    pool: SqlitePool,
}

impl SqlitePersistence {
    pub async fn new(db_path: &Path) -> Result<Self> {
        let db_url = format!("sqlite://{}?mode=rwc", db_path.display());
        let pool = SqlitePool::connect(&db_url).await?;

        sqlx::query(
            r#"
            CREATE TABLE IF NOT EXISTS bot_kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            "#,
        )
        .execute(&pool)
        .await?;

        // Redundant under today's schema, and deliberately kept: `key` is the
        // TEXT PRIMARY KEY, so SQLite already builds a unique B-tree over it
        // and a prefix `LIKE` scan can use that — this extra index does not
        // make list_keys fast and nobody should assume it does. It earns its
        // keep only if `key` stops being the primary key (the future bot_id
        // namespace fix in the module doc); flagged so it is neither deleted
        // by reflex nor trusted as the reason prefix lookups work.
        sqlx::query(
            r#"
            CREATE INDEX IF NOT EXISTS idx_bot_kv_prefix ON bot_kv(key)
            "#,
        )
        .execute(&pool)
        .await?;

        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

#[async_trait]
impl PersistenceProvider for SqlitePersistence {
    async fn get(&self, key: &str) -> Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM bot_kv WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|r| r.get("value")))
    }

    async fn set(&self, key: &str, value: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp();
        sqlx::query(
            r#"
            INSERT INTO bot_kv(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            "#,
        )
        .bind(key)
        .bind(value)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn delete(&self, key: &str) -> Result<()> {
        sqlx::query("DELETE FROM bot_kv WHERE key = ?")
            .bind(key)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn list_keys(&self, prefix: &str) -> Result<Vec<String>> {
        // LIKE metacharacters in a bot-supplied prefix are escaped: the old
        // code interpolated raw input, so prefix "" or "%" enumerated the
        // entire (shared!) table. Pair the escapes with ESCAPE '' below —
        // SQLite does not apply backslash semantics by default.
        let escaped = prefix
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("{}%", escaped);
        let rows = sqlx::query("SELECT key FROM bot_kv WHERE key LIKE ? ESCAPE '\'")
            .bind(pattern)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|r| r.get("key")).collect())
    }
}

pub type SharedPersistence = Arc<SqlitePersistence>;
