// テスト実行時（@cloudflare/vitest-plugin）専用のグローバル型拡張。
// `import { env } from "cloudflare:workers"` の型は Cloudflare.Env に解決されるため、
// wrangler.toml のバインディングと、テスト専用のTEST_MIGRATIONSバインディングをここで宣言しておく。
// トップレベルの import/export を書かないことで「アンビエントなグローバルスクリプト」として
// 扱われ、宣言マージがプロジェクト全体に効くようにしている（本番コード側の型には影響しない）。
declare namespace Cloudflare {
  interface Env {
    AI: Ai;
    DB: D1Database;
    MEMORY_INDEX: VectorizeIndex;
    CHARACTER: DurableObjectNamespace<import("../characterState").CharacterState>;
    ASSETS: Fetcher;
    // vitest.config.ts で readD1Migrations() の結果を渡しているテスト専用バインディング
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
