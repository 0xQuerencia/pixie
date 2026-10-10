"use client";

import React, { useRef, useState } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { SubtitleBrackets } from "./LandingIcons";

interface ToolItem {
  id: string;
  tag: string;
  tagColor: string;
  title: string;
  description: string;
  cta: string;
  graphicType: "arch" | "morph" | "tiles" | "matrix";
  metrics: string[];
}

const TOOLS: ToolItem[] = [
  {
    id: "slack-ingestion",
    tag: "Slack Sync",
    tagColor: "#fec5fb",
    title: "Turn noisy channel chatter into structured, trackable support history.",
    description:
      "Pixie listens quietly across your workspace channels. The instant a genuine question is asked, it captures the thread, extracts the intent, and preserves context without spamming.",
    cta: "Explore Slack Sync",
    graphicType: "arch",
    metrics: ["Sub-50ms event listener", "Deduplicated threads", "Zero DM recording"],
  },
  {
    id: "evidence-engine",
    tag: "Evidence Engine",
    tagColor: "#ff8709",
    title: "Ground every answer in verified docs before uttering a single word.",
    description:
      "No guessing. Pixie crawls your official docs, guidelines, and shipped announcements. If evidence clears the threshold, it cites the source. If it doesn't, it refuses to fabricate.",
    cta: "Explore Evidence Engine",
    graphicType: "morph",
    metrics: ["0.82 Confidence threshold", "Direct URL citations", "Hallucination refusal"],
  },
  {
    id: "smart-handoff",
    tag: "Smart Handoff",
    tagColor: "#9d95ff",
    title: "Never leave a community member stranded. Route directly to domain experts.",
    description:
      "When a question requires human judgment or falls outside documented policy, Pixie generates a crisp executive summary and hands off to the exact organizer who resolved it last time.",
    cta: "Explore Smart Handoff",
    graphicType: "tiles",
    metrics: ["Helper domain routing", "One-click escalation", "Context preservation"],
  },
  {
    id: "knowledge-matrix",
    tag: "Knowledge Matrix",
    tagColor: "#00c5ff",
    title: "Synchronize Notion, GitHub repositories, and past Slack resolutions into unified truth.",
    description:
      "Documentation decays; Slack answers get buried. The Knowledge Matrix continuously syncs your knowledge bases and marks stale answers when guidelines change.",
    cta: "Explore Knowledge Matrix",
    graphicType: "matrix",
    metrics: ["GitHub & Notion sync", "Stale answer alerts", "Retrieval index updates"],
  },
];

export function LandingTools() {
  const containerRef = useRef<HTMLElement>(null);
  const [activeModal, setActiveModal] = useState<ToolItem | null>(null);

  useGSAP(
    () => {
      // 1. Arch breathing animation
      gsap.to(".tool-arch", {
        scaleY: 1.05,
        scaleX: 0.96,
        transformOrigin: "bottom center",
        repeat: -1,
        yoyo: true,
        duration: 3,
        ease: "sine.inOut",
      });

      // 2. Morph squircle rotation & pulse
      gsap.to(".tool-morph", {
        rotation: 8,
        scale: 1.06,
        repeat: -1,
        yoyo: true,
        duration: 3.5,
        ease: "power1.inOut",
      });

      // 3. Floating letter badges
      gsap.to(".tool-badge-1", {
        y: -12,
        rotation: -4,
        repeat: -1,
        yoyo: true,
        duration: 2.4,
        ease: "sine.inOut",
      });
      gsap.to(".tool-badge-2", {
        y: 10,
        rotation: 6,
        repeat: -1,
        yoyo: true,
        duration: 2.8,
        ease: "sine.inOut",
      });

      // 4. Matrix tiles hover & stagger pulse
      gsap.to(".matrix-tile", {
        opacity: 0.5,
        stagger: {
          grid: [3, 3],
          from: "center",
          amount: 1.5,
          repeat: -1,
          yoyo: true,
        },
        duration: 1.2,
        ease: "power2.inOut",
      });
    },
    { scope: containerRef }
  );

  return (
    <section
      id="tools"
      ref={containerRef}
      className="tools-section relative py-32 bg-[#0e100f] text-[#fffce1] border-t border-[#fffce1]/10 overflow-hidden"
    >
      <div className="container mx-auto px-6 sm:px-12 max-w-6xl relative z-10">
        {/* Eyebrow Header */}
        <div className="mb-20">
          <SubtitleBrackets>Pixie® Tools</SubtitleBrackets>
        </div>

        {/* 4 Tool Rows */}
        <div className="divide-y divide-[#fffce1]/10">
          {TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="group py-16 sm:py-24 grid grid-cols-1 lg:grid-cols-12 gap-10 sm:gap-16 items-center transition-colors hover:bg-white/[0.01] rounded-2xl px-4 sm:px-6"
            >
              {/* Left Column: Visual Icon/Graphic */}
              <div className="lg:col-span-5 flex items-center justify-center">
                {tool.graphicType === "arch" && (
                  <div className="tool-arch relative w-52 h-52 sm:w-64 sm:h-64 flex items-end justify-center">
                    <div className="w-full h-full rounded-t-full bg-gradient-to-tr from-[#00c5ff] via-[#9d95ff] to-[#fec5fb] p-6 flex items-end justify-center shadow-2xl shadow-[#00c5ff]/20">
                      <div className="w-20 h-28 bg-[#0e100f] rounded-t-full" />
                    </div>
                  </div>
                )}

                {tool.graphicType === "morph" && (
                  <div className="tool-morph relative w-48 h-48 sm:w-60 sm:h-60 bg-gradient-to-br from-[#ffb443] via-[#ff8709] to-[#d65f00] rounded-[38px] shadow-2xl shadow-[#ff8709]/25 flex items-center justify-center p-6 transform rotate-3">
                    <div className="w-20 h-20 rounded-2xl bg-white/20 backdrop-blur-sm border border-white/30 flex items-center justify-center font-mono font-bold text-white text-xl">
                      ≥ 0.82
                    </div>
                  </div>
                )}

                {tool.graphicType === "tiles" && (
                  <div className="relative w-52 h-52 sm:w-64 sm:h-64 flex items-center justify-center">
                    <div className="w-44 h-44 bg-gradient-to-tr from-[#9d95ff] to-[#fec5fb] rounded-3xl transform -rotate-12 shadow-2xl shadow-[#9d95ff]/30 flex items-center justify-center relative">
                      <span className="tool-badge-1 absolute -top-4 -left-4 bg-[#0e100f] text-[#0ae448] text-xs font-mono font-bold px-3 py-1.5 rounded-full border border-[#0ae448]/40 shadow-lg">
                        @jamie routed
                      </span>
                      <span className="tool-badge-2 absolute -bottom-3 -right-3 bg-[#0e100f] text-[#fffce1] text-xs font-mono font-bold px-3 py-1.5 rounded-full border border-[#fffce1]/30 shadow-lg">
                        PX-1842
                      </span>
                      <span className="text-4xl">🤝</span>
                    </div>
                  </div>
                )}

                {tool.graphicType === "matrix" && (
                  <div className="w-52 h-52 sm:w-64 sm:h-64 grid grid-cols-3 gap-3 p-4 bg-[#141716] border border-[#fffce1]/10 rounded-2xl shadow-2xl">
                    {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                      <div
                        key={i}
                        className={`matrix-tile rounded-xl flex items-center justify-center font-mono text-xs font-bold transition-all ${
                          i % 2 === 0
                            ? "bg-gradient-to-br from-[#00c5ff] to-[#0ae448] text-[#0e100f]"
                            : "bg-[#1f2422] text-[#fffce1]/40"
                        }`}
                      >
                        {i === 4 ? "SYNC" : ""}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Column: Copy & Action */}
              <div className="lg:col-span-7 flex flex-col items-start">
                <span
                  style={{ color: tool.tagColor }}
                  className="text-lg sm:text-xl font-bold tracking-tight mb-4"
                >
                  {tool.tag}
                </span>

                <h3 className="text-2xl sm:text-4xl font-normal tracking-tight leading-snug text-[#fffce1] mb-6">
                  {tool.title}
                </h3>

                <p className="text-base sm:text-lg text-[#fffce1]/70 leading-relaxed mb-8 max-w-xl">
                  {tool.description}
                </p>

                {/* Metrics pill row */}
                <div className="flex flex-wrap gap-2.5 mb-8">
                  {tool.metrics.map((metric) => (
                    <span
                      key={metric}
                      className="text-xs font-mono bg-[#181b1a] text-[#fffce1]/70 border border-[#fffce1]/10 px-3 py-1.5 rounded-full"
                    >
                      ✓ {metric}
                    </span>
                  ))}
                </div>

                <button
                  onClick={() => setActiveModal(tool)}
                  className="inline-flex items-center gap-2 border border-[#fffce1]/30 hover:border-[#fffce1] text-[#fffce1] text-sm sm:text-base font-semibold px-6 py-2.5 rounded-full transition-all duration-200 hover:scale-[1.03] active:scale-[0.98]"
                >
                  {tool.cta}
                  <span aria-hidden>→</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Interactive Tool Modal */}
      {activeModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200"
          onClick={() => setActiveModal(null)}
        >
          <div
            className="bg-[#161918] border border-[#fffce1]/20 rounded-3xl p-8 max-w-lg w-full text-[#fffce1] shadow-2xl relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setActiveModal(null)}
              className="absolute top-6 right-6 text-sm text-[#fffce1]/50 hover:text-[#fffce1] w-8 h-8 rounded-full border border-[#fffce1]/20 flex items-center justify-center"
            >
              ✕
            </button>
            <span
              style={{ color: activeModal.tagColor }}
              className="text-sm font-bold tracking-wider uppercase mb-2 block"
            >
              {activeModal.tag}
            </span>
            <h4 className="text-2xl font-bold mb-4">{activeModal.title}</h4>
            <p className="text-sm text-[#fffce1]/80 leading-relaxed mb-6">
              {activeModal.description}
            </p>
            <div className="space-y-2 mb-6">
              {activeModal.metrics.map((m) => (
                <div key={m} className="flex items-center gap-2 text-sm text-[#0ae448]">
                  <span>•</span>
                  <span>{m}</span>
                </div>
              ))}
            </div>
            <a
              href="/api/auth/login"
              className="block text-center w-full py-3 bg-[#0ae448] text-[#0e100f] font-bold rounded-full hover:bg-[#60ffa0] transition-colors"
            >
              Add Pixie to Slack Now
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
