import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Caption } from "../ui/Caption";
import { MacWindow } from "../ui/MacWindow";
import { ComingIn04 } from "../ui/Pill";
import { copy } from "../copy";
import { settle } from "../motion";
import { C } from "../theme";
import { BAR, BEAT, cue, scenes } from "../timeline";

const TABS = ["General", "Conversations", "Fantasy", "Live alerts", "Advanced"];
const tabAt = (i: number) => BAR + i * BEAT; // General → Conversations → Fantasy → Live alerts, one beat each
cue(scenes.panel.from, 0, "whoosh", 0.6);
for (let i = 0; i < 4; i++) cue(scenes.panel.from, tabAt(i), "click", 0.8);

/** A fast flash of the Mac app in dark mode: the Dashboard, then the Settings tabs one beat each. */
export const ControlPanel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = settle(frame, fps, 0, 16);
  const settings = frame >= tabAt(0);
  const tab = Math.min(3, Math.floor((frame - BAR) / BEAT));
  return (
    <AbsoluteFill>
      <Background />
      <MacWindow title="Waterboy" x={780} y={190} w={1040} h={700} style={{ transform: `translateX(${(1 - s) * 200}px)`, opacity: s }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 220, background: C.macPanel, borderRight: `1px solid ${C.macLine}`, padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <Img src={staticFile("img/icon.png")} style={{ width: 36, height: 36, borderRadius: 8 }} />
            <div style={{ fontWeight: 800, fontSize: 20, color: C.macText }}>Waterboy</div>
          </div>
          {["Dashboard", "Settings", "Logs"].map((n) => {
            const on = n === (settings ? "Settings" : "Dashboard");
            return <div key={n} style={{ padding: "10px 14px", borderRadius: 10, marginBottom: 6, fontSize: 18, fontWeight: 600, background: on ? C.blue2 : "transparent", color: on ? C.white : C.macDim }}>{n}</div>;
          })}
        </div>
        <div style={{ position: "absolute", left: 250, right: 30, top: 26 }}>
          {!settings ? (
            <>
              <div style={{ fontSize: 30, fontWeight: 800, color: C.macText, marginBottom: 20 }}>Dashboard</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <Tile label="Service" value="Running" sub="in the background" good />
                <Tile label="Readiness" value="All set" sub="Messages · Full Disk Access · model" good />
                <Tile label="Last reply" value="2 min ago" sub="Tuesday Night Losers" />
                <Tile label="Data sources" value="ESPN · Sleeper · nflverse" sub="all connected" good />
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 30, fontWeight: 800, color: C.macText, marginBottom: 16 }}>Settings</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
                {TABS.map((t, i) => <div key={t} style={{ padding: "8px 16px", borderRadius: 999, fontSize: 16, fontWeight: 600, background: i === tab ? C.blue2 : C.macPanel, color: i === tab ? C.white : C.macDim, border: `1px solid ${C.macLine}` }}>{t}</div>)}
              </div>
              {(SETTINGS[tab] ?? []).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "16px 4px", borderBottom: `1px solid ${C.macLine}`, fontSize: 19, color: C.macText }}>
                  <span>{k}</span><span style={{ fontWeight: 700, color: C.sky }}>{v}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </MacWindow>
      <Caption main={copy.panel.main} sub={copy.panel.sub} start={4} width={620} size={76} />
      <ComingIn04 />
    </AbsoluteFill>
  );
};

/** A few rows per tab: what each Settings tab is for, at a glance. */
const SETTINGS: [string, string][][] = [
  [["Name", "Waterboy"], ["Provider", "Claude"], ["Model", "Sonnet"]],
  [["Group triggers", "waterboy"], ["Typing indicators", "On"], ["Threaded replies in group chats", "On"]],
  [["ESPN league", "Tuesday Night Losers"], ["Start/sit cards", "On"], ["Trade cards", "On"], ["Roundup awards", "On"]],
  [["Live alerts", "On"], ["Alert when the projection moves", "5%"], ["Check every", "5 min"]],
];

const Tile: React.FC<{ label: string; value: string; sub: string; good?: boolean }> = ({ label, value, sub, good }) => (
  <div style={{ border: `1px solid ${C.macLine}`, borderRadius: 16, padding: 20, background: C.macPanel }}>
    <div style={{ fontSize: 15, fontWeight: 700, color: C.macDim, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color: good ? "#4ade80" : C.macText, marginTop: 6 }}>{value}</div>
    <div style={{ fontSize: 16, color: C.macDim, marginTop: 4 }}>{sub}</div>
  </div>
);
