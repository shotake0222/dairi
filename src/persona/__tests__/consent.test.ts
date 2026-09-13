import { describe, it, expect } from "vitest";
import { CONSENT_VERSION, EMPTY_CONSENT, hasConsent, normalizeConsent } from "../consent";

/**
 * 同意の扱いの検証。
 *
 * ここが緩むと、利用者が説明を読んで許可した範囲を超えてデータが使われる。
 * 「既定はオフ」「版が上がったら取り直し」の2点は、後から取り返しがつかないので厳密に確かめる。
 */

describe("hasConsent", () => {
  it("treats a character with no consent record as not consented", () => {
    expect(hasConsent(undefined, "aggregate")).toBe(false);
    expect(hasConsent(EMPTY_CONSENT, "aggregate")).toBe(false);
  });

  it("honours an explicit yes at the current version", () => {
    const consent = { ...EMPTY_CONSENT, version: CONSENT_VERSION, aggregate: true };
    expect(hasConsent(consent, "aggregate")).toBe(true);
    expect(hasConsent(consent, "marketplace")).toBe(false);
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
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
    expect(consent.marketplace).toBe(false);
    expect(consent.version).toBe(CONSENT_VERSION);
  });

  it("keeps purposes the user already agreed to when they are not mentioned", () => {
    const previous = { ...EMPTY_CONSENT, version: CONSENT_VERSION, profile: true, aggregate: true };
    const consent = normalizeConsent({ marketplace: true }, previous);
    expect(consent.profile).toBe(true);
    expect(consent.aggregate).toBe(true);
    expect(consent.marketplace).toBe(true);
  });

  it("does not carry over consent given against an older version", () => {
    const stale = { ...EMPTY_CONSENT, version: CONSENT_VERSION - 1, profile: true, aggregate: true };
    const consent = normalizeConsent({}, stale);
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
  });

  it("ignores values that are not booleans", () => {
    const consent = normalizeConsent({ profile: "yes", aggregate: 1, marketplace: null });
    expect(consent.profile).toBe(false);
    expect(consent.aggregate).toBe(false);
    expect(consent.marketplace).toBe(false);
  });

  it("can turn a purpose back off", () => {
    const previous = { ...EMPTY_CONSENT, version: CONSENT_VERSION, aggregate: true };
    expect(normalizeConsent({ aggregate: false }, previous).aggregate).toBe(false);
  });
});
