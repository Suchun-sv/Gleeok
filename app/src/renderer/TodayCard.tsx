import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { describeWeather, placeKey, type WeatherSnapshot } from '../../../shared/src/weather.ts';
import { Icon } from './Icons.tsx';
import { WEEKDAYS } from './planner/data.ts';

const WIN_ID = new URLSearchParams(location.search).get('win') ?? 'main';

/** The time now, ticking every few seconds (only while shown). */
function useNow() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The time and date in another zone, and how far it is from here: "14:20", "10月27日 周二", "-8 小时", "明天"/"昨天". */
export function zoneTime(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const there = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const here = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  const hours = Math.round((there - here) / 360_000) / 10;
  const days = Math.round((Date.UTC(+parts.year, +parts.month - 1, +parts.day) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
  const weekday = WEEKDAYS[new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day)).getUTCDay()];
  return {
    time: `${parts.hour.padStart(2, '0')}:${parts.minute.padStart(2, '0')}`,
    date: `${+parts.month}月${+parts.day}日 ${weekday}`,
    monthDay: `${+parts.month}月${+parts.day}日`,
    offset: hours === 0 ? '同一时间' : `${hours > 0 ? '+' : ''}${hours} 小时`,
    day: days > 0 ? '明天' : days < 0 ? '昨天' : '',
  };
}

/** Whether this window shows a clock: always, never, or (by default) while it fills the screen. */
export function clockShown(snap: Snapshot) {
  const mode = snap.state.clock ?? 'fullscreen';
  return mode === 'always' || (mode === 'fullscreen' && snap.fullscreenWindows.includes(WIN_ID));
}

/** A small clock for a tab strip, where the sidebar is not (collapsed, or a separate window). */
export function StripClock() {
  const now = useNow();
  return (
    <span className="strip-clock" title={now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}>
      {hhmm(now)}
    </span>
  );
}

/**
 * Above the 日程 in the sidebar: the time (when the window fills the screen, or always), the date,
 * and the weather; the forecast for the next hours and days opens from it.
 */
export function TodayCard({ snap }: { snap: Snapshot }) {
  const now = useNow();
  // Which place's forecast is open: 'here' or a placeKey.
  const [open, setOpen] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(null);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const w = snap.weather;
  const zones = snap.state.zones ?? [];
  // 显示时钟 governs every place's time alike; without it each place is its weather and name.
  const showClock = clockShown(snap);
  if (!w && !showClock && !zones.length) return null;
  const toggle = (key: string) => setOpen(open === key ? null : key);
  const source = w && (!w.guessed ? '设置里选的城市' : w.source === 'system' ? '系统定位' : w.source === 'zone' ? '按时区估计' : '按 IP 估计');
  return (
    <div className="today-card" ref={box}>
      <div className="today-place">
        {showClock && (
          <div className="today-clock">
            <span className="time">{hhmm(now)}</span>
            <span className="date">
              {/* Beside other places the line names the place instead of the weekday, to fit the sidebar. */}
              {now.getMonth() + 1}月{now.getDate()}日 {zones.length > 0 && w?.place ? `· ${w.place}` : WEEKDAYS[now.getDay()]}
            </span>
          </div>
        )}
        {w && <WeatherRow w={w} showPlace={!showClock} onClick={() => toggle('here')} />}
        {open === 'here' && w && <WeatherPop w={w} source={source!} />}
      </div>
      {zones.map((z) => {
        const t = zoneTime(now, z.timezone);
        const key = placeKey(z);
        const zw = z.latitude !== undefined ? snap.zoneWeather[key] : undefined;
        return (
          <div className="today-place" key={z.timezone + z.name}>
            {!showClock && !zw && (
              <div className="today-weather">
                <span className="label">{t.time}</span>
                <span className="place">{z.name}</span>
              </div>
            )}
            {showClock && (
              <div className="today-clock" title={`${z.timezone}，${t.offset === '同一时间' ? '和这里同一时间' : `比这里${t.offset.startsWith('-') ? '慢' : '快'} ${t.offset.replace(/^[+-]/, '')}`}`}>
                <span className="time">{t.time}</span>
                <span className="date">
                  {t.monthDay} · {z.name}
                </span>
              </div>
            )}
            {zw && <WeatherRow w={zw} showPlace={!showClock} onClick={() => toggle(key)} />}
            {open === key && zw && <WeatherPop w={zw} source={z.detail ?? z.timezone} />}
          </div>
        );
      })}
    </div>
  );
}

/** A place's weather in one line; opens its forecast. */
function WeatherRow({ w, showPlace, onClick }: { w: WeatherSnapshot; showPlace: boolean; onClick: () => void }) {
  const cur = w.current && describeWeather(w.current.code, w.current.isDay);
  return (
    <button
      className="today-weather"
      onClick={onClick}
      title={w.error ? `${w.error}${w.updatedAt ? `（显示的是 ${new Date(w.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 的预报）` : ''}` : '接下来几小时和几天的天气'}
    >
      {cur ? (
        <>
          <Icon name={cur.icon} size={16} />
          <span className="temp">{w.current!.temp}°</span>
          <span className="label">{cur.label}</span>
          {w.today && (
            <span className="range">
              {w.today.min}° / {w.today.max}°
            </span>
          )}
        </>
      ) : (
        <span className="label">{w.error ? '天气暂时取不到' : '正在获取天气…'}</span>
      )}
      {showPlace && <span className="place">{w.place}</span>}
    </button>
  );
}

/** The next hours and days at a place (times are the place's own). */
function WeatherPop({ w, source }: { w: WeatherSnapshot; source: string }) {
  return (
    <div className="weather-pop">
      <div className="weather-pop-head">
        <b>{w.place || '天气'}</b>
        <span className="meta">{source}</span>
        <button className="icon-btn" onClick={() => gleeok.dispatch({ type: 'refreshWeather' })} title="刷新">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {w.error && <p className="hint error">{w.error}</p>}
      <div className="weather-hours">
        {w.hours
          .filter((_, i) => i % 2 === 0)
          .map((h) => {
            const d = describeWeather(h.code);
            return (
              <div key={h.time} title={`${d.label}，降水概率 ${h.rain}%`}>
                <span className="meta">{Number(h.time.slice(0, 2))}时</span>
                <Icon name={d.icon} size={15} />
                <span>{h.temp}°</span>
                {h.rain >= 30 && <span className="rain">{h.rain}%</span>}
              </div>
            );
          })}
      </div>
      <div className="weather-days">
        {w.days.map((d, i) => {
          const day = new Date(`${d.date}T12:00`);
          const desc = describeWeather(d.code);
          return (
            <div key={d.date}>
              <span className="name">{i === 0 ? '今天' : i === 1 ? '明天' : WEEKDAYS[day.getDay()]}</span>
              <Icon name={desc.icon} size={15} />
              <span className="label">{desc.label}</span>
              {d.rain >= 30 && <span className="rain">{d.rain}%</span>}
              <span className="range">
                {d.min}° / {d.max}°
              </span>
            </div>
          );
        })}
      </div>
      <p className="hint">数据来自 Open-Meteo，每半小时更新。城市和时钟在 设置 → 天气与时间。</p>
    </div>
  );
}
