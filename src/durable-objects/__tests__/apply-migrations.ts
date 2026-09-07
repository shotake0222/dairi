import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// セットアップファイルはテストファイルごとのストレージ分離の外側で実行され、複数回呼ばれることがある。
// applyD1Migrations() は未適用のマイグレーションだけを適用するので、ここで毎回呼んでも安全
// （vitest.config.ts で読み込んだ migrations/*.sql を TEST_MIGRATIONS 経由で受け取っている）。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
