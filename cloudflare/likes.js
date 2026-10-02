// SQLite rows keep per-day visitor markers bounded without rewriting a giant KV value.
export class LikeCounter {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const { visitor, day, increment } = await request.json();
    if (!/^[a-f0-9]{64}$/.test(visitor) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof increment !== 'boolean') return new Response('invalid', { status: 400 });
    return this.ctx.blockConcurrencyWhile(async () => {
      const storage = this.ctx.storage, sql = storage.sql;
      sql.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, likes INTEGER NOT NULL, day TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS visitors (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(day,hash))');
      let state = sql.exec('SELECT likes, day FROM counter WHERE id=1').toArray()[0];
      if (!state) {
        // Preserve both the original KV counter and any previous DO object-format state.
        const previous = await storage.get('counter');
        const raw = previous?.likes ?? await this.env.DASH.get('likes');
        const n = Number(raw);
        state = { likes: Number.isSafeInteger(n) && n >= 0 ? n : 0, day: previous?.day || day };
        storage.transactionSync(() => {
          sql.exec('INSERT INTO counter(id,likes,day) VALUES(1,?,?)', state.likes, state.day);
          for (const hash of Object.keys(previous?.visitors || {})) if (/^[a-f0-9]{64}$/.test(hash)) sql.exec('INSERT OR IGNORE INTO visitors(day,hash) VALUES(?,?)', state.day, hash);
        });
      }
      const result = storage.transactionSync(() => {
        state = sql.exec('SELECT likes, day FROM counter WHERE id=1').toArray()[0];
        if (day > state.day) {
          sql.exec('DELETE FROM visitors WHERE day < ?', day);
          sql.exec('UPDATE counter SET day=? WHERE id=1', day);
          state.day = day;
        }
        let alreadyLiked = day < state.day || sql.exec('SELECT hash FROM visitors WHERE day=? AND hash=?', day, visitor).toArray().length > 0;
        if (increment && !alreadyLiked) {
          sql.exec('INSERT INTO visitors(day,hash) VALUES(?,?)', day, visitor);
          sql.exec('UPDATE counter SET likes=likes+1 WHERE id=1');
          state.likes++;
          alreadyLiked = true;
        }
        return { likes: state.likes, alreadyLiked };
      });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    });
  }
}
