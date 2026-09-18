"use strict";

// 应用引导层。
//
// 职责边界（刻意保持很薄）：DOM 就绪 → 建立画布 → 跑渲染循环 → 暴露少量调试用手柄。
// 玩法逻辑（光的传播 / 反射折射 / 关卡与评分等）尚未确定，届时按 <script defer> 顺序
// 新增独立脚本文件（如 scripts/light-engine.js、scripts/renderer.js），
// 与本文件共享全局命名空间，并把新全局补进 eslint.config.js 的 crossScriptGlobals。
//
// 当前画布内容为「待机光晕」占位渲染，只用来验证 DPR 缩放、resize、动效偏好这条链路，
// 玩法定稿后由真正的场景渲染替换。

(function () {
  const canvas = document.getElementById("stage");
  if (!(canvas instanceof HTMLCanvasElement)) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const state = {
    cssWidth: 0,
    cssHeight: 0,
    dpr: 1,
    frameId: 0,
    running: false,
    startedAt: performance.now(),
  };

  // ---------- 尺寸与 DPR ----------

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    state.cssWidth = rect.width;
    state.cssHeight = rect.height;
    state.dpr = dpr;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      // 用设备像素作画，省掉每次绘制时的手工缩放
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  // ---------- 待机场景（占位） ----------

  /**
   * 绘制待机光晕。玩法实现后本函数应被真正的场景渲染替换。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} elapsedMs 自启动以来的毫秒数
   */
  function drawIdleScene(ctx, elapsedMs) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#08090c";
    ctx.fillRect(0, 0, w, h);

    const pulse = reducedMotion.matches ? 0 : 0.5 + 0.5 * Math.sin(elapsedMs / 1400);
    const coreRadius = Math.min(w, h) * (0.045 + 0.012 * pulse);
    const glowRadius = coreRadius * 7;

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);
    glow.addColorStop(0, "rgba(255, 244, 214, 0.92)");
    glow.addColorStop(0.16, "rgba(255, 214, 130, 0.42)");
    glow.addColorStop(0.45, "rgba(255, 176, 66, 0.12)");
    glow.addColorStop(1, "rgba(255, 160, 40, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#fff8e8";
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---------- 渲染循环 ----------

  function frame(now) {
    state.frameId = requestAnimationFrame(frame);
    drawIdleScene(context, now - state.startedAt);
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.frameId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    cancelAnimationFrame(state.frameId);
  }

  // ---------- 装配 ----------

  const resizeObserver = new ResizeObserver(() => {
    resize();
    if (!state.running) drawIdleScene(context, performance.now() - state.startedAt);
  });
  resizeObserver.observe(canvas);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });

  reducedMotion.addEventListener("change", () => {
    if (!state.running) drawIdleScene(context, performance.now() - state.startedAt);
  });

  resize();
  start();

  // 调试手柄：控制台里 __lightGame.stop() / .start() / .resize() 可用
  globalThis.__lightGame = {
    state,
    start,
    stop,
    resize,
    drawIdleScene: () => drawIdleScene(context, performance.now() - state.startedAt),
  };
})();
