"""把 Markdown 渲染成图片，通过已有的 t2i（Playwright 截图）服务出图。

公式用 KaTeX 在本地 Node 里服务端渲染，截图端不需要再拉 CDN。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import aiohttp
from astrbot.api.all import AstrBotConfig, Context, Star, logger
from astrbot.api.event import AstrMessageEvent, filter

PLUGIN_DIR = Path(__file__).resolve().parent
RENDER_JS = PLUGIN_DIR / "render.js"
DEFAULT_ENDPOINT = "http://127.0.0.1:8999"
MAX_MARKDOWN_CHARS = 20000


class Md转图(Star):
    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config
        endpoint = DEFAULT_ENDPOINT
        width = 960
        max_chars = MAX_MARKDOWN_CHARS
        timeout = 40
        if config is not None:
            endpoint = str(config.get("t2i_endpoint") or endpoint).strip() or endpoint
            try:
                width = int(config.get("viewport_width") or width)
            except (TypeError, ValueError):
                width = 960
            try:
                max_chars = int(config.get("max_chars") or max_chars)
            except (TypeError, ValueError):
                max_chars = MAX_MARKDOWN_CHARS
            try:
                timeout = int(config.get("timeout") or timeout)
            except (TypeError, ValueError):
                timeout = 40
        self.endpoint = endpoint.rstrip("/")
        self.viewport_width = max(480, min(width, 1600))
        self.max_chars = max(500, min(max_chars, 80000))
        self.timeout = max(8, min(timeout, 120))
        logger.info(
            f"[md转图] 已加载 endpoint={self.endpoint} width={self.viewport_width}"
        )

    async def _markdown_to_html(self, markdown: str, title: str) -> str:
        if not RENDER_JS.is_file():
            raise RuntimeError(f"找不到渲染脚本: {RENDER_JS}")
        proc = await asyncio.create_subprocess_exec(
            "node",
            str(RENDER_JS),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(PLUGIN_DIR),
        )
        payload = json.dumps(
            {"markdown": markdown, "title": title},
            ensure_ascii=False,
        ).encode("utf-8")
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(payload),
                timeout=20,
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("Markdown 渲染超时") from None
        if proc.returncode != 0:
            err = stderr.decode("utf-8", "replace").strip()[:800]
            raise RuntimeError(f"Markdown 渲染失败: {err or proc.returncode}")
        html = stdout.decode("utf-8")
        if not html.strip():
            raise RuntimeError("Markdown 渲染结果为空")
        return html

    async def _screenshot(self, html: str) -> str:
        body = {
            "html": html,
            "json": True,
            "options": {
                "type": "png",
                "full_page": True,
                "viewport_width": self.viewport_width,
                "device_scale_factor_level": "high",
                "timeout": self.timeout * 1000,
                "animations": "disabled",
            },
        }
        timeout = aiohttp.ClientTimeout(total=self.timeout + 10)
        url = f"{self.endpoint}/text2img/generate"
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, json=body) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise RuntimeError(f"t2i 服务返回 HTTP {resp.status}: {text[:300]}")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"t2i 返回不是 JSON: {text[:200]}") from exc
        if data.get("code") not in (0, None) and not data.get("data"):
            raise RuntimeError(f"t2i 渲染失败: {data}")
        image_id = (data.get("data") or {}).get("id")
        if not image_id:
            raise RuntimeError(f"t2i 没有返回图片 id: {data}")
        image_id = str(image_id).lstrip("/")
        if image_id.startswith("data/"):
            image_id = image_id[len("data/") :]
        return f"{self.endpoint}/text2img/data/{image_id}"

    async def render_and_send(
        self,
        event: AstrMessageEvent,
        markdown: str,
        title: str = "",
    ) -> str:
        markdown = (markdown or "").strip()
        if not markdown:
            return "没有收到要渲染的 Markdown 内容。"
        if len(markdown) > self.max_chars:
            return (
                f"Markdown 太长了（{len(markdown)} 字，上限 {self.max_chars}）。"
                "请拆成几段再渲染。"
            )
        html = await self._markdown_to_html(markdown, title.strip())
        image_url = await self._screenshot(html)
        await event.send(event.image_result(image_url))
        return f"已把 Markdown 渲染成图片并发送。图片地址: {image_url}"

    @filter.llm_tool(name="render_markdown_image")
    async def render_markdown_image(
        self,
        event: AstrMessageEvent,
        markdown: str,
        title: str = "",
    ):
        """把 Markdown 文档渲染成一张排版好的图片，并发送到当前聊天。

        适合长回答、带公式、表格、代码块的内容。公式用 KaTeX（$行内$ 与 $$块级$$），
        代码块会高亮，表格会画边框。调用后图片会直接发到聊天里，不要再把同一段内容用纯文本重复发一遍。

        Args:
            markdown(string): 要渲染的 Markdown 原文。支持标题、列表、表格、代码块、引用，以及 $...$ / $$...$$ 公式。
            title(string): 可选。图片顶部的标题，不填则不显示额外标题。
        """
        try:
            return await self.render_and_send(event, markdown, title)
        except Exception as exc:
            logger.error(f"[md转图] 渲染失败: {exc}", exc_info=True)
            return f"Markdown 转图片失败: {exc}"

    @filter.command("md转图", alias={"渲染md"})
    async def cmd_render(self, event: AstrMessageEvent):
        """手动把本条消息里的 Markdown 转成图片。用法：/md转图 后面接 markdown。"""
        raw = event.get_message_str() or ""
        text = raw.strip()
        for prefix in ("/md转图", "/渲染md", "md转图", "渲染md"):
            if text.startswith(prefix):
                text = text[len(prefix) :].strip()
                break
        if not text:
            yield event.plain_result("用法：/md转图 后面直接跟 Markdown 内容")
            return
        try:
            msg = await self.render_and_send(event, text)
        except Exception as exc:
            logger.error(f"[md转图] 指令渲染失败: {exc}", exc_info=True)
            yield event.plain_result(f"渲染失败: {exc}")
            return
        yield event.plain_result(msg)
