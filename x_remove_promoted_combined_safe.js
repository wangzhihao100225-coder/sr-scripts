// X (Twitter) 去广告 - 终极高可用版 (兼容 Stash / QX / Surge / Loon)
// 核心特性：
// 1. 彻底剔除 Timeline 广告，拒绝“去标不去底”的占位符残留。
// 2. 战略性放行 Thread (评论区) 数据，100% 解决评论区断流/无法刷新问题。
// 3. 引入严格的作用域隔离与异常回滚机制 (Fallback)，防止 OOM 和 App 崩溃。

(function() {
  'use strict';

  function safeParse(body) {
    try { return JSON.parse(body); } catch (e) { return null; }
  }
  function isString(v){ return typeof v === 'string'; }

  // 强大的多语言广告关键词正则
  const adKeywordsRegex = /Promoted|Gesponsert|Promocionado|Sponsorisé|Sponsorizzato|Promowane|Promovido|Реклама|Uitgelicht|Sponsorlu|Promotert|Promoveret|Sponsrad|Mainostettu|Sponzorováno|Promovat|Ajánlott|Προωθημένο|Dipromosikan|Được quảng bá|推廣|推广|推薦|推荐|プロモーション|프로모션|ประชาสัมพันธ์|प्रचारित|বিজ্ঞাপিত|تشہیر شدہ|مُروَّج|تبلیغی|מקודם|Ad|Sponsored|Boosted/i;

  // 核心广告检测逻辑
  function isAdEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;

    const entryId = entry.entryId || '';
    const idLower = isString(entryId) ? entryId.toLowerCase() : '';

    // ID模式匹配
    if (idLower.startsWith('promoted') || idLower.includes('-promoted-') ||
        idLower.includes('-promotedtweet-') || idLower.includes('-advert-') ||
        idLower.includes('promotedtweet') || idLower.includes('promoted_tweet') ||
        idLower.includes('sponsored') || idLower.includes('-sponsored-') ||
        idLower.includes('boosted') || idLower.includes('-ad-') ||
        idLower.includes('adentity')) {
      return true;
    }

    // 字段深度检查
    try {
      const item = entry.content?.itemContent || entry.item?.itemContent || entry.content?.item_content;
      if (item) {
        if (item.promotedMetadata || item.promoted_metadata || item.promoted ||
            item.advertisement || item.adEntity || item.ad || item.sponsoredMetadata ||
            item.boosted || item.ad_info || item.promotion) {
          return true;
        }
        // 文本匹配：检查item中可能含ad关键词的字段
        if (item.legacy?.text && adKeywordsRegex.test(item.legacy.text)) return true;
        if (item.displayType && adKeywordsRegex.test(item.displayType)) return true;
        if (item.card || item.card_uri || item.card_id) return true; 
      }
    } catch (e) {}

    // Top-level字段
    if (entry.ad || entry.adEntity || entry.advertisement || entry.sponsored) return true;
    if (entry.card || entry.card_uri) return true;

    // data-testid映射
    if (entry.__typename && (entry.__typename.includes('Promoted') || entry.__typename.includes('Ad'))) return true;

    return false;
  }

  // 保护分页游标和正常对话流
  function isCursorOrConversation(entry) {
    if (!entry || typeof entry !== 'object') return false;
    const entryId = entry.entryId || '';
    const idLower = isString(entryId) ? entryId.toLowerCase() : '';

    if (idLower.includes('cursor') || idLower.includes('conversation') || idLower.includes('thread') ||
        idLower.includes('reply') || idLower.includes('prompt') || idLower.startsWith('sq-') || idLower.startsWith('timeline-')) {
      return true;
    }

    try {
      if (entry.content?.conversationThread || entry.content?.thread || entry.content?.reply_prompt) return true;
      if (entry.cursor || (entry.content && entry.content.cursor)) return true;
    } catch (e) {}

    return false;
  }

  // 核心过滤执行器
  function processInstructionsEntries(instructions) {
    if (!Array.isArray(instructions)) return false;
    let modified = false;
    let removedCount = 0;

    for (const ins of instructions) {
      if (!ins || typeof ins !== 'object') continue;

      // --- 1. 处理主信息流 Entries ---
      if (Array.isArray(ins.entries)) {
        let originalEntries; // 声明在 try 外部，保证 catch 能访问
        try {
          originalEntries = [...ins.entries];
          const originalLength = ins.entries.length;

          ins.entries = ins.entries.filter(entry => {
            if (!entry || isCursorOrConversation(entry)) return true;

            if (isAdEntry(entry)) {
              // 极端严格的防误杀：如果非常像广告，但缺失了核心的推广元数据，且带有正常文本，则放过
              const item = entry.content?.itemContent || entry.item?.itemContent;
              if (item && item.legacy?.text && !item.promotedMetadata && !item.sponsoredMetadata && !entry.adEntity && !entry.ad) {
                 console.log(`[X-Ad-Blocker] Potential miskill avoided: ${entry.entryId}`);
                 return true;
              }

              modified = true;
              removedCount++;
              console.log(`[X-Ad-Blocker] Removed ad entry: ${entry.entryId}`);
              return false; // 触发剔除
            }
            return true; // 正常推文保留
          });

          // Fallback 回滚机制：如果剔除超过 50% 的数据，认定为 X 接口大改，执行安全回滚
          if (ins.entries.length < originalLength * 0.5) {
            console.log(`[X-Ad-Blocker] Warning: High removal rate (${removedCount}/${originalLength}), fallback triggered.`);
            ins.entries = originalEntries;
            modified = false;
            removedCount = 0;
          }
        } catch (e) {
          console.log(`[X-Ad-Blocker] Entries process error: ${e}`);
          if (originalEntries) ins.entries = originalEntries; 
        }
      }

      // --- 2. 处理模块级广告 Module Items ---
      if (Array.isArray(ins.moduleItems)) {
        let originalModuleItems;
        try {
          originalModuleItems = [...ins.moduleItems];
          const originalLength = ins.moduleItems.length;

          ins.moduleItems = ins.moduleItems.filter(mod => {
            if (!mod) return true;
            const itemContent = mod.item?.itemContent || mod.item?.item_content;
            if (itemContent && (itemContent.promotedMetadata || itemContent.adEntity || itemContent.ad || itemContent.sponsoredMetadata)) {
              modified = true;
              removedCount++;
              console.log(`[X-Ad-Blocker] Removed ad module: ${mod.id || 'unknown'}`);
              return false;
            }
            return true;
          });

          if (ins.moduleItems.length < originalLength * 0.5) {
            console.log(`[X-Ad-Blocker] Warning: High module removal rate, fallback triggered.`);
            ins.moduleItems = originalModuleItems;
          }
        } catch (e) {
          console.log(`[X-Ad-Blocker] Module process error: ${e}`);
          if (originalModuleItems) ins.moduleItems = originalModuleItems;
        }
      }
    }

    if (modified) {
      console.log(`[X-Ad-Blocker] Successfully cleaned ${removedCount} ads.`);
    }

    return modified;
  }

  // --- 脚本主入口 ---
  try {
    if (typeof $response === 'undefined' || !$response || !$response.body) {
      $done({});
      return;
    }

    const raw = $response.body;
    const json = safeParse(raw);
    if (!json) {
      $done({ body: raw });
      return;
    }

    let changed = false;

    // ⚠️ 战略性拦截路径：仅包含 Timeline，已彻底移出 Thread 路径，确保评论区不断流
    const paths = [
      {path: ['data','home','home_timeline_urt','instructions']},
      {path: ['data','home','home_timeline_urt_v2','instructions']},
      {path: ['data','home','timeline_v2','timeline','instructions']},
      {path: ['data','home','timeline_v3','timeline','instructions']},
      {path: ['data','timeline','timeline_v2','instructions']},
      {path: ['data','search_by_raw_query','search_timeline','timeline','instructions']},
      {path: ['data','user','result','timeline_v2','timeline','instructions']}
    ];

    for (const {path} of paths) {
      let node = json;
      for (let i = 0; i < path.length; i++) {
        if (!node) break;
        node = node[path[i]];
      }
      if (Array.isArray(node)) {
        try {
          const res = processInstructionsEntries(node);
          if (res) changed = true;
        } catch (e) {
          console.log(`[X-Ad-Blocker] Path process error: ${e}`);
        }
      }
    }

    if (changed) {
      $done({ body: JSON.stringify(json) });
    } else {
      $done({ body: raw });
    }
  } catch (err) {
    console.log(`[X-Ad-Blocker] Main error: ${err}`);
    $done({ body: $response.body || '' });
  }
})();