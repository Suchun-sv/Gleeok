import type { WeatherPlace, WeatherSnapshot } from '../../../shared/src/weather.ts';
import { log } from './log.ts';

const REFRESH_MS = 30 * 60_000;
const TIMEOUT_MS = 15_000;

/** Places for a name, from Open-Meteo's geocoding (names in Chinese where it has them). */
export async function searchPlaces(name: string): Promise<WeatherPlace[]> {
  const q = name.trim();
  if (!q) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`地点查询失败：HTTP ${res.status}`);
  const body = (await res.json()) as { results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string }[] };
  return (body.results ?? []).map((r) => ({
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    detail: [r.admin1, r.country].filter(Boolean).join('，') || undefined,
  }));
}

const RELOCATE_MS = 3 * 60 * 60_000;

/** Where this machine's IP address is (two free services, no key), or null. */
async function ipLocation(): Promise<{ city: string; latitude: number; longitude: number } | null> {
  const tries: [string, (b: Record<string, unknown>) => { city: string; latitude: number; longitude: number } | null][] = [
    ['https://ipwho.is/', (b) => (b.success && typeof b.city === 'string' ? { city: b.city, latitude: Number(b.latitude), longitude: Number(b.longitude) } : null)],
    [
      'https://ipinfo.io/json',
      (b) => {
        const [lat, lon] = String(b.loc ?? '').split(',').map(Number);
        return typeof b.city === 'string' && Number.isFinite(lat) ? { city: b.city, latitude: lat, longitude: lon } : null;
      },
    ],
  ];
  for (const [url, read] of tries) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const found = res.ok ? read((await res.json()) as Record<string, unknown>) : null;
      if (found) return found;
    } catch {}
  }
  return null;
}

const km = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  Math.hypot((a.latitude - b.latitude) * 111, (a.longitude - b.longitude) * 111 * Math.cos((a.latitude * Math.PI) / 180));

/**
 * No place picked: where the IP address says this machine is, named in Chinese when the geocoder
 * knows a place of that name nearby; failing that, the city of the system time zone.
 */
async function locate(): Promise<WeatherPlace | null> {
  const ip = await ipLocation();
  if (ip) {
    const near = (await searchPlaces(ip.city).catch(() => [])).find((p) => km(p, ip) < 60);
    return near ?? { name: ip.city, latitude: ip.latitude, longitude: ip.longitude };
  }
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const city = zone.split('/').pop()?.replace(/_/g, ' ');
  if (!city || !zone.includes('/')) return null;
  return (await searchPlaces(city))[0] ?? null;
}

/**
 * The sidebar's weather: fetched from Open-Meteo (free, no key) every half hour, and again
 * when the place changes or the machine wakes up.
 */
export class Weather {
  snapshot: WeatherSnapshot | null = null;
  #guess: WeatherPlace | null = null;
  #guessedAt = 0;
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private hooks: {
      /** The place picked in Settings; undefined: guess; null: weather is off. */
      place(): WeatherPlace | null | undefined;
      changed(): void;
    },
  ) {}

  start() {
    void this.refresh();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.refresh(), REFRESH_MS);
  }

  async refresh() {
    const picked = this.hooks.place();
    if (picked === null) {
      this.snapshot = null;
      this.hooks.changed();
      return;
    }
    if (this.#running) return;
    this.#running = true;
    try {
      // A laptop moves: look the IP address up again every few hours.
      if (!picked && (!this.#guess || Date.now() - this.#guessedAt > RELOCATE_MS)) {
        this.#guess = (await locate()) ?? this.#guess;
        this.#guessedAt = Date.now();
      }
      const place = picked ?? this.#guess;
      if (!place) throw new Error('不知道在哪里：在设置里选一个城市');
      const params = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current: 'temperature_2m,weather_code,is_day',
        hourly: 'temperature_2m,weather_code,precipitation_probability',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
        timezone: 'auto',
        forecast_days: '4',
      });
      const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`天气获取失败：HTTP ${res.status}`);
      const b = (await res.json()) as {
        utc_offset_seconds: number;
        current: { temperature_2m: number; weather_code: number; is_day: number };
        hourly: { time: string[]; temperature_2m: number[]; weather_code: number[]; precipitation_probability: (number | null)[] };
        daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] };
      };
      // Hourly times are the place's local time; the next 12 from the current hour there.
      const placeNow = new Date(Date.now() + b.utc_offset_seconds * 1000).toISOString().slice(0, 13);
      const first = Math.max(0, b.hourly.time.findIndex((t) => t.slice(0, 13) >= placeNow));
      const hours = b.hourly.time.slice(first, first + 12).map((time, i) => ({
        time: time.slice(11, 16),
        temp: Math.round(b.hourly.temperature_2m[first + i]),
        code: b.hourly.weather_code[first + i],
        rain: b.hourly.precipitation_probability[first + i] ?? 0,
      }));
      const days = b.daily.time.map((date, i) => ({
        date,
        max: Math.round(b.daily.temperature_2m_max[i]),
        min: Math.round(b.daily.temperature_2m_min[i]),
        code: b.daily.weather_code[i],
        rain: b.daily.precipitation_probability_max[i] ?? 0,
      }));
      this.snapshot = {
        place: place.name,
        guessed: !picked,
        current: { temp: Math.round(b.current.temperature_2m), code: b.current.weather_code, isDay: b.current.is_day === 1 },
        today: days[0] && { max: days[0].max, min: days[0].min, rain: days[0].rain },
        hours,
        days,
        updatedAt: new Date().toISOString(),
      };
    } catch (e) {
      const error = String((e as Error).message ?? e);
      log(`weather: ${error}`);
      // Keep the last forecast if there is one; just say it is stale.
      this.snapshot = this.snapshot ? { ...this.snapshot, error } : { place: picked?.name ?? '', guessed: !picked, hours: [], days: [], error };
    } finally {
      this.#running = false;
      this.hooks.changed();
    }
  }

  /** The place changed in Settings, or the machine woke up (maybe somewhere else): locate and fetch again. */
  placeChanged() {
    this.#guessedAt = 0;
    void this.refresh();
  }
}
