/** The sidebar's weather (Open-Meteo, no key) for a place picked in Settings, else located by IP address. */

export interface WeatherPlace {
  name: string;
  latitude: number;
  longitude: number;
  /** Country / region, to tell places with the same name apart. */
  detail?: string;
  /** IANA time zone, e.g. Asia/Shanghai (from the geocoder). */
  timezone?: string;
}

/** Which weather belongs to a place: its coordinates. */
export const placeKey = (p: { latitude?: number; longitude?: number }) => `${p.latitude?.toFixed(3)},${p.longitude?.toFixed(3)}`;

export interface WeatherSnapshot {
  place: string;
  /** No place picked: this one was located (see source). */
  guessed: boolean;
  /** How a guessed place was found: the system's location service, the IP address, or the time zone. */
  source?: 'system' | 'ip' | 'zone';
  current?: { temp: number; code: number; isDay: boolean };
  today?: { max: number; min: number; rain: number };
  /** The next hours, one per hour. */
  hours: { time: string; temp: number; code: number; rain: number }[];
  /** Today and the next days. */
  days: { date: string; max: number; min: number; code: number; rain: number }[];
  updatedAt?: string;
  error?: string;
}

export type WeatherIcon = 'sun' | 'moon' | 'cloudSun' | 'cloudMoon' | 'cloud' | 'cloudFog' | 'cloudDrizzle' | 'cloudRain' | 'cloudSnow' | 'cloudLightning';

/** WMO weather codes as Open-Meteo reports them: a label and an icon. */
export function describeWeather(code: number, isDay = true): { label: string; icon: WeatherIcon } {
  if (code === 0) return { label: '晴', icon: isDay ? 'sun' : 'moon' };
  if (code === 1) return { label: '大致晴朗', icon: isDay ? 'cloudSun' : 'cloudMoon' };
  if (code === 2) return { label: '多云', icon: isDay ? 'cloudSun' : 'cloudMoon' };
  if (code === 3) return { label: '阴', icon: 'cloud' };
  if (code === 45 || code === 48) return { label: '雾', icon: 'cloudFog' };
  if (code >= 51 && code <= 57) return { label: code >= 56 ? '冻毛毛雨' : '毛毛雨', icon: 'cloudDrizzle' };
  if (code === 61) return { label: '小雨', icon: 'cloudRain' };
  if (code === 63) return { label: '中雨', icon: 'cloudRain' };
  if (code === 65) return { label: '大雨', icon: 'cloudRain' };
  if (code === 66 || code === 67) return { label: '冻雨', icon: 'cloudRain' };
  if (code === 71) return { label: '小雪', icon: 'cloudSnow' };
  if (code === 73) return { label: '中雪', icon: 'cloudSnow' };
  if (code === 75 || code === 77) return { label: code === 77 ? '雪粒' : '大雪', icon: 'cloudSnow' };
  if (code >= 80 && code <= 82) return { label: code === 82 ? '强阵雨' : '阵雨', icon: 'cloudRain' };
  if (code === 85 || code === 86) return { label: '阵雪', icon: 'cloudSnow' };
  if (code === 95) return { label: '雷雨', icon: 'cloudLightning' };
  if (code === 96 || code === 99) return { label: '雷雨冰雹', icon: 'cloudLightning' };
  return { label: '—', icon: 'cloud' };
}
