use std::path::Path;

use anyhow::Result;
use swoop_engine::Status;
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::model::{AfterQueue, DownloadRecord, MAIN_QUEUE, NewDownload, Queue, Settings};

pub struct Db {
    conn: Connection,
}

fn enum_to_sql<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v).unwrap().as_str().unwrap_or_default().to_owned()
}

fn enum_from_sql<T: serde::de::DeserializeOwned>(s: String) -> T {
    serde_json::from_value(serde_json::Value::String(s)).unwrap()
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS downloads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                url TEXT NOT NULL,
                page_url TEXT,
                file_name TEXT NOT NULL,
                dest_dir TEXT NOT NULL,
                category TEXT NOT NULL,
                status TEXT NOT NULL,
                size INTEGER,
                downloaded INTEGER NOT NULL DEFAULT 0,
                headers TEXT NOT NULL DEFAULT '[]',
                kind TEXT NOT NULL DEFAULT 'http',
                video_format TEXT,
                cookies_file TEXT,
                queue_id INTEGER,
                description TEXT NOT NULL DEFAULT '',
                error TEXT,
                resumable INTEGER NOT NULL DEFAULT 0,
                added_at INTEGER NOT NULL,
                last_try_at INTEGER,
                completed_at INTEGER,
                queue_pos INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS queues (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                max_concurrent INTEGER NOT NULL DEFAULT 2,
                schedule TEXT,
                after_done TEXT NOT NULL DEFAULT 'nothing'
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT OR IGNORE INTO queues (id, name, max_concurrent) VALUES (1, 'Main download queue', 2);
            "#,
        )?;
        // Anything mid-flight when the app last stopped is now stopped.
        conn.execute("UPDATE downloads SET status = 'paused' WHERE status IN ('downloading', 'probing')", [])?;
        Ok(Self { conn })
    }

    fn row_to_record(r: &Row) -> rusqlite::Result<DownloadRecord> {
        Ok(DownloadRecord {
            id: r.get("id")?,
            url: r.get("url")?,
            page_url: r.get("page_url")?,
            file_name: r.get("file_name")?,
            dest_dir: r.get("dest_dir")?,
            category: r.get("category")?,
            status: enum_from_sql(r.get("status")?),
            size: r.get::<_, Option<i64>>("size")?.map(|v| v as u64),
            downloaded: r.get::<_, i64>("downloaded")? as u64,
            headers: serde_json::from_str(&r.get::<_, String>("headers")?).unwrap_or_default(),
            kind: enum_from_sql(r.get("kind")?),
            video_format: r.get("video_format")?,
            cookies_file: r.get("cookies_file")?,
            queue_id: r.get("queue_id")?,
            description: r.get("description")?,
            error: r.get("error")?,
            resumable: r.get::<_, i64>("resumable")? != 0,
            added_at: r.get("added_at")?,
            last_try_at: r.get("last_try_at")?,
            completed_at: r.get("completed_at")?,
        })
    }

    pub fn list(&self) -> Result<Vec<DownloadRecord>> {
        let mut st = self.conn.prepare("SELECT * FROM downloads ORDER BY id")?;
        let rows = st.query_map([], Self::row_to_record)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: i64) -> Result<Option<DownloadRecord>> {
        Ok(self.conn.query_row("SELECT * FROM downloads WHERE id = ?1", [id], Self::row_to_record).optional()?)
    }

    pub fn insert(&self, d: &NewDownload, status: Status) -> Result<i64> {
        let pos: i64 = self.conn.query_row("SELECT COALESCE(MAX(queue_pos), 0) + 1 FROM downloads", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO downloads (url, page_url, file_name, dest_dir, category, status, size, headers, kind,
                video_format, cookies_file, queue_id, description, resumable, added_at, queue_pos)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                d.url,
                d.page_url,
                d.file_name,
                d.dest_dir,
                d.category,
                enum_to_sql(&status),
                d.size.map(|s| s as i64),
                serde_json::to_string(&d.headers)?,
                enum_to_sql(&d.kind),
                d.video_format,
                d.cookies_file,
                d.queue_id,
                d.description,
                d.resumable as i64,
                now(),
                pos
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn set_status(&self, id: i64, status: Status, error: Option<&str>) -> Result<()> {
        let completed = (status == Status::Completed).then(now);
        self.conn.execute(
            "UPDATE downloads SET status = ?2, error = ?3, completed_at = COALESCE(?4, completed_at) WHERE id = ?1",
            params![id, enum_to_sql(&status), error, completed],
        )?;
        Ok(())
    }

    pub fn mark_started(&self, id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE downloads SET status = 'downloading', error = NULL, last_try_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
        Ok(())
    }

    pub fn set_progress(&self, id: i64, downloaded: u64, size: Option<u64>) -> Result<()> {
        self.conn.execute(
            "UPDATE downloads SET downloaded = ?2, size = COALESCE(?3, size) WHERE id = ?1",
            params![id, downloaded as i64, size.map(|s| s as i64)],
        )?;
        Ok(())
    }

    pub fn set_file(&self, id: i64, file_name: &str, resumable: Option<bool>) -> Result<()> {
        self.conn.execute(
            "UPDATE downloads SET file_name = ?2, resumable = COALESCE(?3, resumable) WHERE id = ?1",
            params![id, file_name, resumable.map(|r| r as i64)],
        )?;
        Ok(())
    }

    pub fn set_url(&self, id: i64, url: &str, headers: Option<&[(String, String)]>) -> Result<()> {
        match headers {
            Some(h) => self.conn.execute(
                "UPDATE downloads SET url = ?2, headers = ?3 WHERE id = ?1",
                params![id, url, serde_json::to_string(h)?],
            )?,
            None => self.conn.execute("UPDATE downloads SET url = ?2 WHERE id = ?1", params![id, url])?,
        };
        Ok(())
    }

    pub fn set_queue(&self, id: i64, queue_id: Option<i64>) -> Result<()> {
        self.conn.execute("UPDATE downloads SET queue_id = ?2 WHERE id = ?1", params![id, queue_id])?;
        Ok(())
    }

    pub fn delete(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM downloads WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Unfinished downloads of a queue in queue order.
    pub fn queue_pending(&self, queue_id: i64) -> Result<Vec<i64>> {
        let mut st = self.conn.prepare(
            "SELECT id FROM downloads WHERE queue_id = ?1 AND status IN ('queued', 'paused', 'failed')
             ORDER BY queue_pos, id",
        )?;
        let rows = st.query_map([queue_id], |r| r.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn queues(&self) -> Result<Vec<Queue>> {
        let mut st = self.conn.prepare("SELECT id, name, max_concurrent, schedule, after_done FROM queues ORDER BY id")?;
        let rows = st.query_map([], |r| {
            Ok(Queue {
                id: r.get(0)?,
                name: r.get(1)?,
                max_concurrent: r.get::<_, i64>(2)? as usize,
                schedule: r.get::<_, Option<String>>(3)?.and_then(|s| serde_json::from_str(&s).ok()),
                after_done: enum_from_sql::<AfterQueue>(r.get(4)?),
                running: false,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn save_queue(&self, q: &Queue) -> Result<i64> {
        let schedule = q.schedule.as_ref().map(serde_json::to_string).transpose()?;
        if q.id > 0 {
            self.conn.execute(
                "UPDATE queues SET name = ?2, max_concurrent = ?3, schedule = ?4, after_done = ?5 WHERE id = ?1",
                params![q.id, q.name, q.max_concurrent as i64, schedule, enum_to_sql(&q.after_done)],
            )?;
            Ok(q.id)
        } else {
            self.conn.execute(
                "INSERT INTO queues (name, max_concurrent, schedule, after_done) VALUES (?1, ?2, ?3, ?4)",
                params![q.name, q.max_concurrent as i64, schedule, enum_to_sql(&q.after_done)],
            )?;
            Ok(self.conn.last_insert_rowid())
        }
    }

    pub fn delete_queue(&self, id: i64) -> Result<()> {
        if id == MAIN_QUEUE {
            anyhow::bail!("the main queue can't be deleted");
        }
        self.conn.execute("UPDATE downloads SET queue_id = ?2 WHERE queue_id = ?1", params![id, MAIN_QUEUE])?;
        self.conn.execute("DELETE FROM queues WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn settings(&self) -> Result<Settings> {
        let raw: Option<String> =
            self.conn.query_row("SELECT value FROM settings WHERE key = 'settings'", [], |r| r.get(0)).optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES ('settings', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [serde_json::to_string(s)?],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Kind;

    fn new_dl(name: &str, queue: Option<i64>) -> NewDownload {
        NewDownload {
            url: format!("https://example.com/{name}"),
            page_url: None,
            file_name: name.into(),
            dest_dir: "C:\\Downloads".into(),
            category: crate::categories::category_for(name).into(),
            size: Some(10),
            headers: vec![("Cookie".into(), "a=b".into())],
            kind: Kind::Http,
            video_format: None,
            cookies_file: None,
            queue_id: queue,
            description: String::new(),
            resumable: true,
        }
    }

    #[test]
    fn round_trips_and_queue_order() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        let a = db.insert(&new_dl("a.zip", Some(MAIN_QUEUE)), Status::Queued).unwrap();
        let b = db.insert(&new_dl("b.mp4", Some(MAIN_QUEUE)), Status::Queued).unwrap();
        let _c = db.insert(&new_dl("c.pdf", None), Status::Queued).unwrap();
        let rec = db.get(a).unwrap().unwrap();
        assert_eq!(rec.headers, vec![("Cookie".to_string(), "a=b".to_string())]);
        assert_eq!(rec.status, Status::Queued);
        assert_eq!(db.queue_pending(MAIN_QUEUE).unwrap(), vec![a, b]);
        db.set_status(a, Status::Completed, None).unwrap();
        assert_eq!(db.queue_pending(MAIN_QUEUE).unwrap(), vec![b]);
        assert!(db.get(a).unwrap().unwrap().completed_at.is_some());
    }

    #[test]
    fn interrupted_downloads_become_paused_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let id = {
            let db = Db::open(&path).unwrap();
            let id = db.insert(&new_dl("a.zip", None), Status::Queued).unwrap();
            db.mark_started(id).unwrap();
            id
        };
        let db = Db::open(&path).unwrap();
        assert_eq!(db.get(id).unwrap().unwrap().status, Status::Paused);
    }

    #[test]
    fn settings_default_then_persist() {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::open(&dir.path().join("t.db")).unwrap();
        let mut s = db.settings().unwrap();
        assert_eq!(s.connections, Settings::default().connections);
        s.connections = 16;
        db.save_settings(&s).unwrap();
        assert_eq!(db.settings().unwrap().connections, 16);
    }
}
