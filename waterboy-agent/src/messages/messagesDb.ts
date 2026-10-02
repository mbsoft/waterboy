import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { decodeAttributedBody } from "./attributedBody.ts";
import { expandHome } from "../config.ts";

export interface Attachment {
  path: string; // absolute path on disk
  mimeType: string | null;
  name: string | null;
  uti: string | null;
}

export interface IncomingMessage {
  rowid: number;
  guid: string;
  text: string;
  sender: string | null; // handle id: phone or email
  chatGuid: string;
  chatIdentifier: string;
  chatName: string | null;
  isGroup: boolean;
  isAudio: boolean;
  date: Date;
  attachments: Attachment[];
}

interface Row {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  is_from_me: number;
  date_ms: number;
  is_audio_message: number;
  associated_message_type: number;
  item_type: number;
  cache_has_attachments: number;
  sender: string | null;
  chat_guid: string;
  chat_identifier: string;
  display_name: string | null;
  style: number;
}

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

/** `ms` = milliseconds since 2001-01-01. chat.db stores nanoseconds (seconds before
 * High Sierra); the SQL converts to ms because raw ns exceed JS's safe-integer range. */
export function appleDate(ms: number): Date {
  return new Date(APPLE_EPOCH_MS + Number(ms));
}

/** Strip U+FFFC object-replacement chars that stand in for attachments. */
function cleanText(s: string): string {
  return s.replace(/\uFFFC/g, "").trim();
}

export interface RecentChat {
  guid: string;
  identifier: string;
  name: string | null;
  isGroup: boolean;
  members: string[];
  lastMessageAt: string | null;
}

export class MessagesDb {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath, { readOnly: true });
  }

  /**
   * Recently active chats (newest first) with their members, for the desktop app's
   * Conversations page, which can't read chat.db itself without Full Disk Access.
   */
  recentChats(limit = 60): RecentChat[] {
    const rows = this.db
      .prepare(
        `SELECT c.guid, c.chat_identifier, c.display_name, c.style,
                -- seconds since 2001 (newer chat.db stores nanoseconds, too big for a JS number)
                CAST(CASE WHEN MAX(cmj.message_date) > 1000000000000 THEN MAX(cmj.message_date) / 1000000000
                          ELSE MAX(cmj.message_date) END AS INTEGER) AS last,
                (SELECT group_concat(h.id, ',') FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id
                  WHERE chj.chat_id = c.ROWID) AS members
           FROM chat c JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
          GROUP BY c.ROWID ORDER BY MAX(cmj.message_id) DESC LIMIT ?`,
      )
      .all(limit) as { guid: string; chat_identifier: string; display_name: string | null; style: number; last: number | null; members: string | null }[];
    return rows.map((r) => ({
      guid: r.guid,
      identifier: r.chat_identifier,
      name: r.display_name || null,
      isGroup: r.style === 43,
      members: r.members ? r.members.split(",") : [],
      lastMessageAt: r.last ? new Date(Date.UTC(2001, 0, 1) + r.last * 1000).toISOString() : null,
    }));
  }

  /** One chat by GUID, or null if chat.db doesn't have it. Used to check a group-alert target. */
  chat(guid: string): { guid: string; identifier: string; name: string | null; isGroup: boolean } | null {
    const r = this.db.prepare("SELECT guid, chat_identifier, display_name, style FROM chat WHERE guid = ?").get(guid) as
      | { guid: string; chat_identifier: string; display_name: string | null; style: number }
      | undefined;
    return r ? { guid: r.guid, identifier: r.chat_identifier, name: r.display_name || null, isGroup: r.style === 43 } : null;
  }

  maxRowId(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(ROWID), 0) AS m FROM message").get() as { m: number };
    return Number(r.m);
  }

  /** Messages (from anyone, including us) newer than `afterRowId`. */
  fetchSince(afterRowId: number, limit = 200): { messages: IncomingMessage[]; lastRowId: number } {
    const rows = this.db
      .prepare(
        `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me,
                CASE WHEN m.date > 100000000000 THEN m.date / 1000000 ELSE m.date * 1000 END AS date_ms,
                m.is_audio_message, m.associated_message_type, m.item_type, m.cache_has_attachments,
                h.id AS sender, c.guid AS chat_guid, c.chat_identifier, c.display_name, c.style
           FROM message m
           JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
           JOIN chat c ON c.ROWID = cmj.chat_id
           LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.ROWID > ?
          ORDER BY m.ROWID ASC
          LIMIT ?`,
      )
      .all(afterRowId, limit) as unknown as Row[];

    let lastRowId = afterRowId;
    const out: IncomingMessage[] = [];
    for (const r of rows) {
      lastRowId = Math.max(lastRowId, Number(r.rowid));
      if (r.is_from_me) continue; // our own outgoing messages
      if (r.associated_message_type !== 0) continue; // tapbacks / reactions
      if (r.item_type !== 0) continue; // renames, member joins, etc.
      const text = cleanText(r.text ?? decodeAttributedBody(r.attributedBody) ?? "");
      const attachments = r.cache_has_attachments ? this.attachmentsFor(Number(r.rowid)) : [];
      if (!text && attachments.length === 0) continue;
      out.push({
        rowid: Number(r.rowid),
        guid: r.guid,
        text,
        sender: r.sender,
        chatGuid: r.chat_guid,
        chatIdentifier: r.chat_identifier,
        chatName: r.display_name || null,
        isGroup: r.style === 43,
        isAudio: !!r.is_audio_message,
        date: appleDate(r.date_ms),
        attachments,
      });
    }
    return { messages: out, lastRowId };
  }

  attachmentsFor(messageRowId: number): Attachment[] {
    const rows = this.db
      .prepare(
        `SELECT a.filename, a.mime_type, a.transfer_name, a.uti
           FROM attachment a
           JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
          WHERE maj.message_id = ?`,
      )
      .all(messageRowId) as { filename: string | null; mime_type: string | null; transfer_name: string | null; uti: string | null }[];
    return rows
      .filter((r) => r.filename)
      .map((r) => ({
        path: path.resolve(expandHome(r.filename!)),
        mimeType: r.mime_type,
        name: r.transfer_name,
        uti: r.uti,
      }));
  }

  close() {
    this.db.close();
  }
}
