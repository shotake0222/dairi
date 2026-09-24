import { describe, it, expect } from "vitest";
import { BUNDLED_WITH_TERMS, CONSENT_TEXTS, CONSENT_VERSION, ConsentState, EMPTY_CONSENT, hasConsent, normalizeConsent, OPT_IN_ONLY } from "../consent";

/**
 * 同意の扱いの検証。
 *
 * ここが緩むと、利用者が説明を読んで許可した範囲を超えてデータが使われる。
 * 次の3点は後から取り返しがつかないので、厳密に確かめる。
 *   - 同意していない人は、どの用途も false のまま
 *   - 版が上がったら取り直し（古い同意を流用しない）
 *   - **設定で止めた用途が、次に開いたときに黙って戻らない**
 *     （terms に束ねた以上、ここが一番壊れやすい）
 */

describe("hasConsent", () => {
  it("treats a character with no consent record as not consented", () => {
    expect(hasConsent(undefined, "aggregate")).toBe(false);
    expect(hasConsent(EMPTY_CONSENT, "aggregate")).toBe(false);
  });

  it("honours an explicit yes at the current version", () => {
    const consent = { ...EMPTY_CONSENT, version: CONSENT_VERSION, aggregate: true };
    expect(hasConsent(consent, "aggregate")).toBe(true);
    expect(hasConsent(consent, "terms")).toBe(false);
  });

  it("invalidates consent given against an older version of the wording", () => {
    // 文面を変えたのに古い同意を使い回すのは、黙って範囲を広げるのと同じ
    const stale = { ...EMPTY_CONSENT, version: CONSENT_VERSION - 1, aggregate: true, profile: true };
    expect(hasConsent(stale, "aggregate")).toBe(false);
    expect(hasConsent(stale, "profile")).toBe(false);
  });
});

describe("normalizeConsent", () => {
  it("defaults every purpose to false", () => {
    const consent = normalizeConsent({});
    expect(consent.terms).toBe(false);
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
    expect(consent.version).toBe(CONSENT_VERSION);
  });

  it("keeps purposes the user already agreed to when they are not mentioned", () => {
    const previous = { ...EMPTY_CONSENT, version: CONSENT_VERSION, profile: true, aggregate: true };
    const consent = normalizeConsent({ terms: true }, previous);
    expect(consent.profile).toBe(true);
    expect(consent.aggregate).toBe(true);
    expect(consent.terms).toBe(true);
  });

  it("does not carry over consent given against an older version", () => {
    const stale = { ...EMPTY_CONSENT, version: CONSENT_VERSION - 1, profile: true, aggregate: true };
    const consent = normalizeConsent({}, stale);
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
  });

  it("ignores values that are not booleans", () => {
    const consent = normalizeConsent({ profile: "yes", aggregate: 1, terms: null });
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
    expect(consent.terms).toBe(false);
  });

  it("can turn a purpose back off", () => {
    const previous = { ...EMPTY_CONSENT, version: CONSENT_VERSION, aggregate: true };
    expect(normalizeConsent({ aggregate: false }, previous).aggregate).toBe(false);
  });

  it("turns on the bundled purposes when the user agrees to the terms", () => {
    // 入口で聞くのは terms ひとつ。使い道は本文で全部見せたうえで一緒に有効になる
    const consent = normalizeConsent({ terms: true });
    for (const purpose of BUNDLED_WITH_TERMS) {
      expect(consent[purpose]).toBe(true);
    }
  });

  it("does not bundle anything when the terms were refused", () => {
    const consent = normalizeConsent({ terms: false });
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
  });

  it("never re-enables a purpose the user switched off in the settings", () => {
    // ここが戻ると、止めたはずの用途が次回の同意確認で復活する。一番やってはいけない挙動
    const previous = { ...EMPTY_CONSENT, version: CONSENT_VERSION, terms: true, profile: true, aggregate: false };
    const consent = normalizeConsent({ terms: true }, previous);
    expect(consent.aggregate).toBe(false);
    expect(consent.profile).toBe(true);
  });
});

describe("法人への個別提供（individual）は、はじめるときの同意に束ねる（版5から）", () => {
  it("terms に同意すると、3つの使い道がすべて有効になる（「あなたのこと」のトグルは全部オン）", () => {
    const c = normalizeConsent({ terms: true });
    expect(c.profile).toBe(true);
    expect(c.aggregate).toBe(true);
    expect(c.individual).toBe(true);
  });

  it("設定で止めた人を、黙って戻さない", () => {
    const off = normalizeConsent({ individual: false }, normalizeConsent({ terms: true }));
    expect(off.individual).toBe(false);
    expect(normalizeConsent({ terms: true }, off).individual).toBe(false);
    expect(normalizeConsent({ aggregate: false }, off).individual).toBe(false);
  });

  it("本人が入れ直せば有効になり、別の項目を触っても落ちない", () => {
    const on = normalizeConsent({ individual: true }, normalizeConsent({ individual: false }, normalizeConsent({ terms: true })));
    expect(hasConsent(on, "individual")).toBe(true);
    expect(normalizeConsent({ aggregate: false }, on).individual).toBe(true);
  });

  it("始めてもいない（terms が無い）分身では、入れても有効にならない", () => {
    expect(normalizeConsent({ individual: true }).individual).toBe(false);
  });

  it("入口の同意に束ねる項目に入り、渡るもの・渡らないものを文面で言い切っている", () => {
    expect(BUNDLED_WITH_TERMS).toContain("individual");
    expect(OPT_IN_ONLY).not.toContain("individual");
    expect(CONSENT_TEXTS.individual.note).toContain("会話の本文");
    expect(CONSENT_TEXTS.individual.body).toContain("年収を除く");
    // 事業者名の括弧書きは出さない（「運営」だけ）
    expect(CONSENT_TEXTS.individual.body).not.toContain("Straid");
    expect(CONSENT_TEXTS.terms.body).toContain("3つの使い道");
  });
});
