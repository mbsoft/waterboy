import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "../ui/Background";
import { Caption } from "../ui/Caption";
import { MacWindow } from "../ui/MacWindow";
import { copy } from "../copy";
import { settle } from "../motion";
import { C } from "../theme";
import { BEAT, cue, scenes } from "../timeline";

const SETTINGS = BEAT * 5;
cue(scenes.panel.from, 0, "open", 0.7);
cue(scenes.panel.from, SETTINGS, "click");

const TABS = ["General", "Conversations", "Fantasy", "Live alerts", "Advanced"];

/** A flash of the Mac app: the Dashboard, then the Settings tabs. */
export const ControlPanel: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = settle(frame, fps, 0, 20);
  const settings = frame >= SETTINGS;
  return (
    <AbsoluteFill>
      <Background />
      <MacWindow title="Waterboy" x={120} y={130} w={1100} h={720} style={{ transform: `scale(${0.9 + 0.1 * s})`, opacity: s }}>
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 230, background: "#f3f5f9", borderRight: `1px solid ${C.line}`, padding: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <Img src={staticFile("img/icon.png")} style={{ width: 36, height: 36, borderRadius: 8 }} />
            <div style={{ fontWeight: 800, fontSize: 20, color: C.ink }}>Waterboy</div>
          </div>
          {["Dashboard", "Settings", "Logs"].map((n) => {
            const on = (n === "Settings") === settings && n !== "Logs";
            return <div key={n} style={{ padding: "10px 14px", borderRadius: 10, marginBottom: 6, fontSize: 18, fontWeight: 600, background: on ? C.blue2 : "transparent", color: on ? C.white : C.dim }}>{n}</div>;
          })}
        </div>
        <div style={{ position: "absolute", left: 260, right: 30, top: 26 }}>
          {!settings ? (
            <>
              <div style={{ fontSize: 30, fontWeight: 800, color: C.ink, marginBottom: 20 }}>Dashboard</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <Tile label="Service" value="Running" sub="in the background" good />
                <Tile label="Last reply" value="2 min ago" sub={'"Tuesday Night Losers"'} />
                <Tile label="Usage" value="$0.42 today" sub="Claude · 38 replies" />
                <Tile label="Data sources" value="ESPN · Sleeper · nflverse" sub="all connected" good />
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 30, fontWeight: 800, color: C.ink, marginBottom: 16 }}>Settings</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 22 }}>
                {TABS.map((t) => <div key={t} style={{ padding: "8px 16px", borderRadius: 999, fontSize: 16, fontWeight: 600, background: t === "Live alerts" ? C.blue2 : "#eef2f8", color: t === "Live alerts" ? C.white : C.dim }}>{t}</div>)}
              </div>
              {[["Live alerts", "On"], ["Alert when the projection moves", "5%"], ["Check every", "5 min"], ["Caption", "Off"]].map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "16px 4px", borderBottom: `1px solid ${C.line}`, fontSize: 19, color: C.ink }}>
                  <span>{k}</span><span style={{ fontWeight: 700, color: C.blue }}>{v}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </MacWindow>
      <Caption text={copy.panel.caption} start={10} x={1300} y={330} width={540} size={72} />
    </AbsoluteFill>
  );
};

const Tile: React.FC<{ label: string; value: string; sub: string; good?: boolean }> = ({ label, value, sub, good }) => (
  <div style={{ border: `1px solid ${C.line}`, borderRadius: 16, padding: 20, background: C.white }}>
    <div style={{ fontSize: 15, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: 1 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 800, color: good ? "#15803d" : C.ink, marginTop: 6 }}>{value}</div>
    <div style={{ fontSize: 16, color: C.dim, marginTop: 4 }}>{sub}</div>
  </div>
);
