// 等待本地服务就绪（start-desktop.cmd 使用）
const port = Number(process.env.ZDXR_PORT || '4879');
const deadline = Date.now() + 45000;
(async () => {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (r.ok) process.exit(0);
    } catch { /* 未就绪 */ }
    await new Promise((res) => setTimeout(res, 600));
  }
  process.exit(1);
})();