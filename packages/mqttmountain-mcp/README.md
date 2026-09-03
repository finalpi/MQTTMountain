# mqttmountain-mcp

MCP server for reading MQTTMountain message logs from AI clients.

## Usage

After publishing this package to npm:

```json
{
  "mcpServers": {
    "mqttmountain": {
      "command": "npx",
      "args": ["-y", "mqttmountain-mcp"]
    }
  }
}
```

If MQTTMountain uses a custom log directory, pass it explicitly:

```json
{
  "mcpServers": {
    "mqttmountain": {
      "command": "npx",
      "args": [
        "-y",
        "mqttmountain-mcp",
        "--log-dir",
        "C:/Users/you/AppData/Roaming/MQTTMountain/message_logs"
      ]
    }
  }
}
```

## Tools

- `mqttmountain_connections`: List saved MQTTMountain connections and log folders.
- `mqttmountain_recent_messages`: Read recent messages for one connection. Accepts `connectionId` or `connectionName`, plus optional exact `topic`.
- `mqttmountain_message_status`: Read a compact recent-message summary in one call. Accepts `connectionId`, `connectionName`, or fuzzy `connectionKeyword`, plus optional `topic`, `topicKeyword`, `keyword`, and `minutes`.
- `mqttmountain_payload_samples`: Read compact latest payload samples. Returns JSON keys, common fields, byte length, and short previews by default.
- `mqttmountain_history_index_status`: Report how many history DB files have complete indexed search tables.
- `mqttmountain_query_history`: Query persisted messages by connection, topic, keyword, and time range. Accepts `connectionId`, `connectionName`, or fuzzy `connectionKeyword`.

## History search

`mqttmountain_query_history` uses MQTTMountain's per-day `history_messages` index when a day database has a complete index. If an index is missing or incomplete, the tool automatically falls back to decoding the original `buckets` table, so old logs still work.

Version 0.1.7 supports both legacy uncompressed buckets and the v6 `MMZ1` compressed bucket format used by current hourly shards.

Time values use Unix timestamps in milliseconds:

```json
{
  "connectionKeyword": "深圳星扬",
  "startTime": 1780588800000,
  "endTime": 1780675200000,
  "keyword": "camera_screen_drag",
  "limit": 100
}
```

Keyword matching is case-insensitive and ignores whitespace. Multiple keyword search is supported:

```json
{
  "connectionKeyword": "深圳星扬",
  "keywords": ["alarm", "battery"],
  "keywordLogic": "and",
  "order": "desc",
  "limit": 100,
  "offset": 0
}
```

Advanced conditions take precedence over `keyword` and `keywords`:

```json
{
  "conditions": [
    { "term": "alarm", "join": "and" },
    { "term": "offline", "join": "or" },
    { "term": "debug", "join": "not" }
  ],
  "order": "asc",
  "limit": 200
}
```

Use `offset` with `limit` for pagination. `order` can be `desc` or `asc`. When no connection is selected,
results are merged across connections before global ordering and pagination. The merge keeps one streaming
candidate per connection, so deep offsets are traversed once and do not allocate
`connections × (offset + limit)` result arrays. Indexed rows skipped by pagination do not load payload blobs.

History-reading tools also accept `timeoutMs` (100–120000; default 15000, or 60000 for exact status aggregation). Reads reuse one idle worker to
avoid paying the SQLite/SDK startup cost on every call; overlapping reads use isolated workers. A timed-out
or client-cancelled request terminates only its worker instead of blocking the MCP stdio server.

## Recent status and samples

`mqttmountain_message_status` and `mqttmountain_payload_samples` accept `startTime` and `endTime`. If `startTime` is omitted, they use `minutes` as a lookback window ending at `endTime` or now. Their `keyword` search also ignores whitespace and is case-insensitive.

Without a payload `keyword`, `mqttmountain_message_status` keeps exact window counts. Fully covered closed
shards use `history_topic_stats` when its completion marker is present; boundary ranges and older databases
fall back to the covering history index or bucket counts. Payload-keyword status searches use `scanLimit`
(default 200, maximum 5000); their `total` and per-topic counts cover the newest scanned matches, and
`truncated: true` means more matches may exist.
