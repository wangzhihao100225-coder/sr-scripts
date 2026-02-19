// X 去广告 - 合并版（精确检测 + 保守 neutralize）
// 目标：尽量移除广告内容、保留占位与分页/会话相关字段，避免破坏评论/刷新
(function() {
  'use strict';

  function safeParse(body) {
    try { return JSON.parse(body); } catch (e) { return null; }
  }
  function isString(v){ return typeof v === 'string'; }

  // 是否明显为广告（精确且保守的检测）
  function isAdEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;

    const entryId = entry.entryId || '';
    const idLower = isString(entryId) ? entryId.toLowerCase() : '';

    // 常见广告 id 模式（保守匹配）
    if (idLower === 'promoted' || idLower.startsWith('promoted') ||
        idLower.includes('-promoted-') || idLower.includes('-promotedtweet-') ||
        idLower.includes('-advert-') || idLower.includes('promotedtweet') ||
        idLower.includes('promoted_tweet') || idLower.includes('sponsored')) {
      return true;
    }

    // itemContent 中的 promotedMetadata 等字段（多种命名）
    try {
      const item = entry.content?.itemContent || entry.item?.itemContent || entry.content?.item_content;
      if (item) {
        if (item.promotedMetadata || item.promoted_metadata || item.promoted || item.advertisement || item.adEntity || item.ad) {
          return true;
        }
        // 某些广告以 card 形式出现
        if (item.card || item.card_uri || item.card_id) return true;
      }
    } catch (e) {}

    // top-level card/ad 字段
    if (entry.card || entry.card_uri || entry.ad || entry.adEntity || entry.advertisement) return true;

    // module / moduleItems 里可能有广告标记（外层检测在调用处）
    return false;
  }

  // 判断是否为 cursor / conversation / thread 相关条目（这些不能删）
  function isCursorOrConversation(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const entryId = entry.entryId || '';
    const idLower = isString(entryId) ? entryId.toLowerCase() : '';

    if (idLower.includes('cursor') || idLower.includes('conversation') || idLower.includes('thread') ||
        idLower.includes('reply') || idLower.startsWith('sq-') || idLower.startsWith('timeline-')) {
      return true;
    }

    // 如果条目内部包含 "cursor" 字段（保守检查），不要删除
    try {
      if (entry.cursor || (entry.content && entry.content.cursor)) return true;
      // 小规模字符串搜索（限制长度，避免极端成本）
      const s = JSON.stringify(entry);
      if (s && s.length < 2000 && s.toLowerCase().includes('"cursor"')) return true;
    } catch (e) {}

    return false;
  }

  // 将广告条目 neutralize（返回轻量壳，保留 entryId / cursor / 少量元数据）
  function neutralizeAdEntry(entry) {
    try {
      const shell = { entryId: entry.entryId };

      // 保留 clientEventInfo / any small top-level metadata
      if (entry.clientEventInfo) shell.clientEventInfo = entry.clientEventInfo;
      if (entry.content && entry.content.clientEventInfo) {
        shell.content = shell.content || {};
        shell.content.clientEventInfo = entry.content.clientEventInfo;
      }

      // 保留 cursor 若存在（非常重要）
      if (entry.cursor) shell.cursor = entry.cursor;
      if (entry.content && entry.content.cursor) {
        shell.content = shell.content || {};
        shell.content.cursor = entry.content.cursor;
      }

      // 最小化 itemContent：保留标识性字段，移除广告大字段
      const item = entry.content?.itemContent || entry.item?.itemContent || entry.content?.item_content;
      if (item && typeof item === 'object') {
        const safeItem = {};
        // 保留少量识别字段，避免破坏前端索引
        if (item.__typename) safeItem.__typename = item.__typename;
        if (item.displayType) safeItem.displayType = item.displayType;
        if (item.tweet_results && item.tweet_results.result) {
          safeItem.tweet_results = { result: {} };
          if (item.tweet_results.result.rest_id) safeItem.tweet_results.result.rest_id = item.tweet_results.result.rest_id;
          if (item.tweet_results.result.legacy && item.tweet_results.result.legacy.id_str) {
            safeItem.tweet_results.result.legacy = { id_str: item.tweet_results.result.legacy.id_str };
          }
        }
        // legacy 小字段
        if (item.legacy && typeof item.legacy === 'object') {
          safeItem.legacy = {};
          if (item.legacy.id_str) safeItem.legacy.id_str = item.legacy.id_str;
          if (item.legacy.created_at) safeItem.legacy.created_at = item.legacy.created_at;
        }

        shell.content = shell.content || {};
        shell.content.itemContent = safeItem;
      }

      // 保留 module 或 moduleItem id（若有）
      if (entry.moduleId) shell.moduleId = entry.moduleId;
      if (entry.module_item) shell.module_item = entry.module_item;

      return shell;
    } catch (e) {
      // 出错就返回原条目（更安全）
      return entry;
    }
  }

  // 处理 instructions 中的 entries（使用 map 保留占位）
  function processInstructionsEntries(instructions) {
    if (!Array.isArray(instructions)) return false;
    let modified = false;

    for (const ins of instructions) {
      if (!ins || typeof ins !== 'object') continue;

      // 常见的 entries 容器
      if (Array.isArray(ins.entries)) {
        try {
          ins.entries = ins.entries.map(entry => {
            if (!entry) return entry;
            // 永远不要触碰 cursor / conversation / thread 相关条目
            if (isCursorOrConversation(entry)) return entry;
            // 仅当明确广告时做 neutralize
            if (isAdEntry(entry)) {
              modified = true;
              return neutralizeAdEntry(entry);
            }
            return entry;
          });
        } catch (e) { /* 保守：出错不改 */ }
      }

      // TimelineAddToModule 或其它可能含 moduleItems 的类型：用 map 保留位置
      if (Array.isArray(ins.moduleItems)) {
        try {
          ins.moduleItems = ins.moduleItems.map(mod => {
            if (!mod) return mod;
            // module.item 可能包含 itemContent
            const itemContent = mod.item?.itemContent || mod.item?.item_content;
            if (itemContent && (itemContent.promotedMetadata || itemContent.card || itemContent.adEntity || itemContent.ad)) {
              modified = true;
              // 用轻量壳替换 mod（保留 id）
              const modShell = { id: mod.id || mod.moduleId || mod.module_item || null };
              if (mod.clientEventInfo) modShell.clientEventInfo = mod.clientEventInfo;
              return modShell;
            }
            return mod;
          });
        } catch (e) { /* 保守 */ }
      }
    }

    return modified;
  }

  try {
    if (typeof $response === 'undefined' || !$response || !$response.body) {
      $done({});
      return;
    }

    const raw = $response.body;
    const json = safeParse(raw);
    if (!json) {
      // 非 JSON，直接放行
      $done({ body: raw });
      return;
    }

    let changed = false;

    // 常见 timeline/thread 路径（覆盖多种可能）
    const paths = [
      ['data','home','home_timeline_urt','instructions'],
      ['data','home','timeline_v2','timeline','instructions'],
      ['data','timeline','timeline_v2','instructions'],
      ['data','search_by_raw_query','search_timeline','timeline','instructions'],
      ['data','user','result','timeline_v2','timeline','instructions'],
      ['data','threaded_conversation_with_injections_v2','instructions'],
      ['data','threaded_conversation_with_injections','instructions']
    ];

    for (const path of paths) {
      let node = json;
      for (let i = 0; i < path.length; i++) {
        if (!node) break;
        node = node[path[i]];
      }
      if (Array.isArray(node)) {
        try {
          const res = processInstructionsEntries(node);
          if (res) changed = true;
        } catch (e) { /* 保守 */ }
      }
    }

    // 如果有改动则序列化返回，否则原样返回以节约开销
    if (changed) {
      try {
        $done({ body: JSON.stringify(json) });
      } catch (e) {
        // 序列化失败，放行原始响应
        console.log('X 去广告 合并版 序列化失败:', e);
        $done({ body: raw });
      }
    } else {
      $done({ body: raw });
    }
  } catch (err) {
    // 任何异常都放行原始响应，避免影响评论/分页等功能
    try { console.log('X 去广告 合并版 执行异常:', err); } catch (e) {}
    $done({ body: $response.body || '' });
  }
})();