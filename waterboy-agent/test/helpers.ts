import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Minimal subset of the real chat.db schema. */
export function makeFakeChatDb(): { path: string; db: DatabaseSync; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imsg-test-"));
  const p = path.join(dir, "chat.db");
  const db = new DatabaseSync(p);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, service TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, chat_identifier TEXT, display_name TEXT, style INTEGER);
    CREATE TABLE message (
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT, text TEXT, attributedBody BLOB,
      handle_id INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, date INTEGER DEFAULT 0,
      is_audio_message INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0,
      item_type INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT, mime_type TEXT, transfer_name TEXT, uti TEXT);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
  `);
  return { path: p, db, dir };
}

export function addChat(db: DatabaseSync, guid: string, identifier: string, name: string | null, group: boolean): number {
  return Number(
    db.prepare("INSERT INTO chat (guid, chat_identifier, display_name, style) VALUES (?, ?, ?, ?)").run(guid, identifier, name, group ? 43 : 45)
      .lastInsertRowid,
  );
}

export function addHandle(db: DatabaseSync, id: string): number {
  return Number(db.prepare("INSERT INTO handle (id, service) VALUES (?, 'iMessage')").run(id).lastInsertRowid);
}

export function addMessage(
  db: DatabaseSync,
  chatId: number,
  handleId: number,
  opts: { text?: string | null; body?: Uint8Array; fromMe?: boolean; tapback?: boolean; attachment?: { file: string; mime: string }; audio?: boolean },
): number {
  const r = db
    .prepare(
      `INSERT INTO message (guid, text, attributedBody, handle_id, is_from_me, date, is_audio_message, associated_message_type, cache_has_attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `msg-${Math.random()}`,
      opts.text ?? null,
      opts.body ?? null,
      handleId,
      opts.fromMe ? 1 : 0,
      BigInt(Date.now() - Date.UTC(2001, 0, 1)) * 1000000n,
      opts.audio ? 1 : 0,
      opts.tapback ? 2000 : 0,
      opts.attachment ? 1 : 0,
    );
  const id = Number(r.lastInsertRowid);
  // Real chat.db stores nanoseconds since 2001 (too big for a JS number).
  db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)").run(chatId, id, BigInt(Date.now() - Date.UTC(2001, 0, 1)) * 1000000n);
  if (opts.attachment) {
    const a = Number(
      db.prepare("INSERT INTO attachment (filename, mime_type, transfer_name) VALUES (?, ?, ?)").run(opts.attachment.file, opts.attachment.mime, path.basename(opts.attachment.file))
        .lastInsertRowid,
    );
    db.prepare("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (?, ?)").run(id, a);
  }
  return id;
}
