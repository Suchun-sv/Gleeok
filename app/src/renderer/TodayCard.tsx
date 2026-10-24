import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../../shared/src/ipc.ts';
import { describeWeather } from '../../../shared/src/weather.ts';
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
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const w = snap.weather;
  const showClock = clockShown(snap);
  if (!w && !showClock) return null;
  const cur = w?.current && describeWeather(w.current.code, w.current.isDay);
  const date = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEKDAYS[now.getDay()]}`;
  return (
    <div className="today-card" ref={box}>
      {showClock && (
        <div className="today-clock">
          <span className="time">{hhmm(now)}</span>
          <span className="date">{date}</span>
        </div>
      )}
      {w && (
        <button
          className="today-weather"
          onClick={() => setOpen(!open)}
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
          {!showClock && <span className="place">{w.place}</span>}
        </button>
      )}
      {open && w && (
        <div className="weather-pop">
          <div className="weather-pop-head">
            <b>{w.place || '天气'}</b>
            <span className="meta">{w.guessed ? '按 IP 定位' : '设置里选的城市'}</span>
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
      )}
    </div>
  );
}
