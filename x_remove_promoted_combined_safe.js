// X (Twitter) 去广告 - 2026 高可用升级版 (兼容 Stash / QX / Surge / Loon)
// 作者：原脚本 + Grok 优化
// 核心改进：新增路径 + 强化 __typename 检测

(function() {
  'use strict';

  function safeParse(body) {
    try { return JSON.parse(body); } catch (e) { return null; }
  }
  function isString(v){ return typeof v === 'string'; }

  // 多语言广告关键词（保持原版）
  const adKeywordsRegex = /Promoted|Gesponsert|Promocionado|Sponsorisé|Sponsorizzato|Promowane|Promovido|Реклама|Uitgelicht|Sponsorlu|Promotert|Promoveret|Sponsrad|Mainostettu|Sponzorováno|Promovat|Ajánlott|Προωθημένο|Dipromosikan|Được quảng bá|推廣|推广|推薦|推荐|プロモーション|프로모션|ประชาสัมพันธ์|प्रचारित|বিজ্ঞাপিত|تشہیر شدہ|مُروَّج|تبلیغی|מקודם|Ad|Sponsored|Boosted/i;

  // 增强版广告检测（新增 __typename 判断）
  function isAdEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;

    const entryId = entry.entryId || '';
    const idLower = isString(entryId) ? entryId.toLowerCase() : '';

    // ID 模式（原版保留 + 加强）
    if (idLower.startsWith('promoted') || idLower.includes('-promoted-') ||
        idLower.includes('-promotedtweet-') || idLower.includes('-advert-') ||
        idLower.includes('promotedtweet') || idLower.includes('promoted_tweet') ||
        idLower.includes('sponsored') || idLower.includes('-sponsored-') ||
        idLower.includes('boosted') || idLower.includes('-ad-') ||
        idLower.includes('adentity')) {
      return true;
    }

    // 新增：GraphQL __typename 检测（2025-2026 主流广告类型）
    if (entry.__typename && (
        entry.__typename.includes('Promoted') ||
        entry.__typename === 'TimelineTimelinePromoted' ||
        entry.__typename === 'TimelinePromotedItem' ||
        entry.__typename === 'PromotedTweet')) {
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
        // __typename 再查一次
        if (item.__typename && (
            item.__typename.includes('Promoted') ||
            item.__typename === 'TimelinePromotedItem')) {
          return true;
        }
        if (item.legacy?.text && adKeywordsRegex.test(item.legacy.text)) return true;
        if (item.displayType && adKeywordsRegex.test(item.displayType)) return true;
        if (item.card || item.card_uri || item.card_id) return true; 
      }
    } catch (e) {}

    // Top-level
    if (entry.ad || entry.adEntity || entry.advertisement || entry.sponsored) return true;
    if (entry.card || entry.card_uri) return true;

    return false;
  }

  // 保护游标和评论区（原版逻辑不变）
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

  // 核心过滤器（保持原版安全回滚机制）
  function processInstructionsEntries(instructions) {
    if (!Array.isArray(instructions)) return false;
    let modified = false;
    let removedCount = 0;

    for (const ins of instructions) {
      if (!ins || typeof ins !== 'object') continue;

      // 1. 处理主信息流 Entries
      if (Array.isArray(ins.entries)) {
        let originalEntries;
        try {
          originalEntries = [...ins.entries];
          const originalLength = ins.entries.length;

          ins.entries = ins.entries.filter(entry => {
            if (!entry || isCursorOrConversation(entry)) return true;

            if (isAdEntry(entry)) {
              // 防误杀保护
              const item = entry.content?.itemContent || entry.item?.itemContent;
              if (item && item.legacy?.text && !item.promotedMetadata && !item.sponsoredMetadata && !entry.adEntity && !entry.ad) {
                console.log(`[X-Ad-Blocker-2026] Potential miskill avoided: ${entry.entryId}`);
                return true;
              }

              modified = true;
              removedCount++;
              console.log(`[X-Ad-Blocker-2026] Removed ad entry: ${entry.entryId || 'unknown'}`);
              return false;
            }
            return true;
          });

          // Fallback 回滚（超过 50% 删除就恢复）
          if (ins.entries.length < originalLength * 0.5) {
            console.log(`[X-Ad-Blocker-2026] Warning: High removal rate (${removedCount}/${originalLength}), fallback triggered.`);
            ins.entries = originalEntries;
            modified = false;
            removedCount = 0;
          }
        } catch (e) {
          console.log(`[X-Ad-Blocker-2026] Entries process error: ${e}`);
          if (originalEntries) ins.entries = originalEntries;
        }
      }

      // 2. 处理 Module Items
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
              console.log(`[X-Ad-Blocker-2026] Removed ad module: ${mod.id || 'unknown'}`);
              return false;
            }
            return true;
          });

          if (ins.moduleItems.length < originalLength * 0.5) {
            console.log(`[X-Ad-Blocker-2026] Warning: High module removal rate, fallback triggered.`);
            ins.moduleItems = originalModuleItems;
          }
        } catch (e) {
          console.log(`[X-Ad-Blocker-2026] Module process error: ${e}`);
          if (originalModuleItems) ins.moduleItems = originalModuleItems;
        }
      }
    }

    if (modified) {
      console.log(`[X-Ad-Blocker-2026] Successfully cleaned ${removedCount} ads.`);
    }
    return modified;
  }

  // 主入口
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

    // ⚠️ 2026 新增路径（覆盖更多 Timeline）
    const paths = [
      {path: ['data','home','home_timeline_urt','instructions']},
      {path: ['data','home','home_timeline_urt_v2','instructions']},
      {path: ['data','home','home_timeline_urt_v3','instructions']},     // 新增
      {path: ['data','home','timeline_v2','timeline','instructions']},
      {path: ['data','home','timeline_v3','timeline','instructions']},
      {path: ['data','home','timeline_v4','timeline','instructions']},   // 新增
      {path: ['data','timeline','timeline_v2','instructions']},
      {path: ['data','timeline','timeline_v3','instructions']},
      {path: ['data','search_by_raw_query','search_timeline','timeline','instructions']},
      {path: ['data','user','result','timeline_v2','timeline','instructions']},
      {path: ['data','user','result','timeline_v3','timeline','instructions']}, // 新增
      {path: ['data','userByScreenName','result','timeline_v2','timeline','instructions']} // 新增
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
          console.log(`[X-Ad-Blocker-2026] Path process error: ${e}`);
        }
      }
    }

    if (changed) {
      $done({ body: JSON.stringify(json) });
    } else {
      $done({ body: raw });
    }
  } catch (err) {
    console.log(`[X-Ad-Blocker-2026] Main error: ${err}`);
    $done({ body: $response.body || '' });
  }
})();