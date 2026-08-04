// Everyone on the floor gets a name, a job title and a mouth.
// Panels speak english; the people on the floor speak turkish.

const FIRST = [
  "Bilge", "Doruk", "Ece", "Kerem", "Nil", "Ozan", "Selin", "Tuna", "Yagmur", "Emre",
  "Deniz", "Ilke", "Mert", "Zeynep", "Arda", "Cansu", "Ege", "Efe", "Melis", "Sarp",
  "Poyraz", "Lodos", "Kivanc", "Alp", "Duru", "Umut", "Berk", "Asli",
];
const LAST = [
  "Kablo", "Tostcu", "Gecikme", "Bufer", "Cekirdek", "Sekmeli", "Yorgun", "Kahveci",
  "Onbellek", "Sigorta", "Nokta", "Vardiya", "Sifir", "Kirmizi", "Gurultu", "Tampon",
];
const TITLES = [
  "intern", "junior", "grunt", "temp", "night owl", "grinder", "specialist",
  "contractor", "apprentice", "operator", "cog", "fixer",
];

export function pick<T>(arr: T[], rnd = Math.random): T {
  return arr[Math.floor(rnd() * arr.length)];
}

export function makeName(taken: Set<string>): string {
  for (let i = 0; i < 60; i++) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!taken.has(n)) return n;
  }
  return `Worker ${taken.size + 1}`;
}

export function makeTitle(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("free") || m.includes("auto/best-free")) return "unpaid intern";
  if (m.includes("opus") || m.includes("gpt-5") || m.includes("sonnet")) return "senior (expensive)";
  if (m.includes("haiku") || m.includes("mini") || m.includes("flash") || m.includes("lite")) return "fast hands";
  return pick(TITLES);
}

/** What a worker mutters when a job lands on their desk. */
export const ACCEPT_LINES = [
  "tamamdir patron.",
  "yapiyorum yapiyorum.",
  "bir tane daha mi?",
  "hallederim.",
  "bir saniye ver.",
  "token ucuz, benim vaktim degil.",
  "bana bir kahve borclusun.",
  "hmm. peki.",
  "isiniyorum...",
  "bu kapsam disi bence.",
  "gecenin bu saatinde mi?",
];

export const DONE_LINES = [
  "bitti. sirada ne var?",
  "gonderdim.",
  "al bakalim, oku.",
  "ciktisi masanda.",
  "kolay para.",
  "gereginden uzun surdu.",
  "bitti. zam istiyorum.",
  "temiz cikti.",
  "buyur efendim.",
];

export const FAIL_LINES = [
  "patladi.",
  "gateway kabul etmedi.",
  "bu sartlarda calisamam.",
  "yine limit yedik.",
  "benim sucum degil. herhalde.",
  "model bogazina takildi.",
];

export const IDLE_LINES = [
  "...",
  "zzz",
  "saat 3 olmus bile",
  "*soguk kahveden yudumlar*",
  "uyuyor olabilirdim",
  "bana bir is verin",
  "bosluga bakiyorum",
  "bu saatte kim calisir",
  "klima yine bozuk",
];

export const BOSS_LINES = [
  "sen. masa. simdi.",
  "kucuk is, kafa yorma.",
  "ucuz token, buyuk hayaller.",
  "sunu halledin.",
  "bunu dune istiyordum.",
];

export const COFFEE_LINE = "kahve. bes dakika.";

export const GHOST_NOTE =
  "GHOST OUTPUT - OmniRoute gateway'ine ulasilamadi, yani hicbir modele bir sey gonderilmedi. " +
  "OmniRoute'u baslat (npm i -g omniroute && omniroute) ve bu masa gercek is yapsin.";

/** When a listed model refuses to serve and OmniRoute's router takes over. */
export const fallbackLine = (model: string) =>
  `${model} burada servis edilmiyor. auto'ya geciyorum.`;
