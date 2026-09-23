/*
 * 種族と色の一覧（画面側の唯一の定義元）。
 *
 * 以前は home / friends / admin の3画面がそれぞれ種族の名前を書き写していて、
 * 種族を足すと必ずどこかが古いまま残った（図鑑の総数が合わない、名前がローマ字で出る、など）。
 * 画面はすべてこのファイルを読む。サーバー側の定義元は src/durable-objects/characterState.ts の
 * SPECIES_KEYS / SPECIES_LABELS / COLOR_KEYS で、**並びも名前もこことずれないこと**を
 * src/__tests__/index.test.ts が確かめている。
 *
 *   <script src="/species.js"></script>   ← 使う画面のスクリプトより前に、defer なしで
 *   WaketamaSpecies.order / .colors / .label("hoshipo") / .image("hoshipo", "sky")
 */
(function () {
  "use strict";

  var LABELS = {
    punikoro: "ぷにころ",
    mofukuru: "もふくる",
    tsunomaru: "つのまる",
    howahowa: "ほわほわ",
    kiratsubu: "きらつぶ",
    // 2026-09-23 に追加した10種族
    hoshipo: "ほしぽ",
    kinokon: "きのこん",
    tamatori: "たまとり",
    mimipyon: "みみぴょん",
    futabaru: "ふたばる",
    kuragekko: "くらげっこ",
    nyamaru: "にゃまる",
    kamenko: "かめんこ",
    ponpoko: "ぽんぽこ",
    futatama: "ふたたま",
    // 2026-09-23 にさらに足した10種族（25種族×6色=150通り）
    togemaru: "とげまる",
    pentama: "ぺんたま",
    kumarun: "くまるん",
    konkon: "こんこん",
    gekomaru: "げこまる",
    paon: "ぱおん",
    merumo: "めるも",
    patamori: "ぱたもり",
    shizukun: "しずくん",
    kujiran: "くじらん",
  };

  var ORDER = [
    "punikoro", "mofukuru", "tsunomaru", "howahowa", "kiratsubu",
    "hoshipo", "kinokon", "tamatori", "mimipyon", "futabaru",
    "kuragekko", "nyamaru", "kamenko", "ponpoko", "futatama",
    "togemaru", "pentama", "kumarun", "konkon", "gekomaru",
    "paon", "merumo", "patamori", "shizukun", "kujiran",
  ];

  var COLORS = ["coral", "sky", "leaf", "sun", "lavender", "peach"];

  var COLOR_LABELS = {
    coral: "コーラル",
    sky: "スカイ",
    leaf: "リーフ",
    sun: "サン",
    lavender: "ラベンダー",
    peach: "ピーチ",
  };

  window.WaketamaSpecies = {
    order: ORDER.slice(),
    colors: COLORS.slice(),
    labels: LABELS,
    colorLabels: COLOR_LABELS,
    label: function (key) {
      return LABELS[key] || key || "";
    },
    colorLabel: function (key) {
      return COLOR_LABELS[key] || key || "";
    },
    image: function (species, color) {
      return "/characters/" + species + "_" + color + ".png";
    },
    model: function (species, color) {
      return "/characters/" + species + "_" + color + ".glb";
    },
  };
})();
