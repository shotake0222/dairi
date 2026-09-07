import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * テスト実行基盤（2026/9/7導入）。
 *
 * それまではpersonality/signalExtractor/speechStyleのような「入出力だけの純粋関数」しか
 * テストできていなかった。Durable Object本体（characterState.ts）のロジック——特に
 * 所有者トークンによるアクセス制御のような、間違えるとセキュリティ上の問題に直結する部分——には
 * 一切の自動テストが無い状態だった。
 *
 * @cloudflare/vitest-plugin はテストをworkerdランタイム上で実際に動かせるため、
 * D1・Durable Object・Vectorize・Workers AIをwrangler.tomlの設定のまま使ってテストできる。
 * ただしAI/Vectorizeにはローカルシミュレータが無く、実際に呼ぶとCloudflareアカウントに
 * アクセスして課金が発生してしまうため、remoteBindings: false にした上で、
 * テスト側で env.AI.run / env.MEMORY_INDEX.* を vi.spyOn によってモックする方針にしている
 * （chat()等はAI呼び出し失敗時にフォールバック文言を返す設計なので、モックが無くても
 * クラッシュはしないが、決定的な結果を検証するためモックを使う）。
 */
export default defineConfig(async () => {
  // D1マイグレーション（migrations/*.sql）を読み込み、テスト専用バインディング
  // TEST_MIGRATIONS 経由でsetupFile（apply-migrations.ts）に渡す。
  // ここはNode.js側で評価されるので、ファイルシステムから直接読める。
  const migrationsPath = path.join(import.meta.dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        // AI/Vectorizeはローカルシミュレータが無く、実バインディングだと実際にCloudflareへ
        // アクセスしてしまう（課金対象になりうる）。テストでは常にモックを使うのでオフにする。
        remoteBindings: false,
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./src/durable-objects/__tests__/apply-migrations.ts"],
    },
  };
});
