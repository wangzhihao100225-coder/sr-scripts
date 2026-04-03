// X (Twitter) 去广告 - 2026 终极加强版 v3 (兼容 Stash / QX / Surge / Loon)
// 已强化检测 + 新路径 + 调试日志

(function() {
  'use strict';

  function safeParse(body) {
    try { return JSON.parse(body); } catch (e) { return null; }
  }
  function isString(v){ return typeof v === 'string'; }

  const adKeywordsRegex = /Promoted|Gesponsert|Promocionado|Sponsorisé|Sponsorizzato|Promowane|Promovido|Реклама|Uitgelicht|Sponsorlu|Promotert|Promoveret|Sponsrad|Mainostettu|Sponzorováno|Promovat|Ajánlott|Προωθημένο|Dipromosikan|Được quảng bá|推廣|推广|推薦|推荐|プロモーション|프로모션|ประชาสัมพันธ์|प्रचारित|বিজ্ঞাপিত|تشہیر شدہ|مُروَّج|تبلیغی|מקודם|Ad|Sponsored|Boosted/i;

  // 终极广告检测（新增递归 + 2026 新 __typename）
  function isAdEntry(entry) {
    if (!entry || typeof entry !== 'object') return false;

    const entryId = entry.entryId || '';
    const idLower = isString(entryId) ? entryId.toLowerCase() : '';

    // ID 模式
    if (idLower.includes('promoted') || idLower.includes('sponsored') || idLower.includes('boosted') || idLower.includes('adentity')) {
      return true;
    }

    // 2026 新 __typename 检测
    const typename = entry.__typename || '';
    if (typename.includes('Promoted') || 
        typename === 'TimelineTimelinePromoted' || 
        typename === 'TimelinePromotedItem' || 
        typename === 'PromotedTweet' || 
        typename === 'TimelinePromotedTweet') {
      return true;
    }

    // 递归深度检查（防止广告藏得深）
    function deepCheck(obj) {
      if (!obj || typeof obj !== 'object') return false;
      if (obj.promotedMetadata || obj.promoted_metadata || obj.promoted || 
          obj.adEntity || obj.ad || obj.sponsoredMetadata || obj.isPromoted || 
          obj.ad_info || obj.promotion) {
        return true;
      }
      if (obj.__typename && (obj.__typename.includes('Promoted') || obj.__typename.includes('Ad'))) return true;
      if (obj.legacy?.text && adKeywordsRegex.test(obj.legacy.text)) return true;
      if (obj.displayType && adKeywordsRegex.test(obj.displayType)) return true;

      // 递归子对象
      for (const key in obj) {
        if (deepCheck(obj[key])) return true;
      }
      return false;
    }

    try {
      const item = entry.content?.itemContent || entry.item?.itemContent || entry.content?.item_content || entry.content;
      if (item && deepCheck(item)) return true;
      if (deepCheck(entry)) return true;
    } catch (e) {}

    return false;
  }

  // 保护游标和评论区（不变）
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

  // 核心过滤（临时关闭 50% 回滚，方便测试）
  function processInstructionsEntries(instructions) {
    if (!Array.isArray(instructions)) return false;
    let modified = false;
    let removedCount = 0;

    for (const ins of instructions) {
      if (!ins || typeof ins !== 'object') continue;

      if (Array.isArray(ins.entries)) {
        let originalLength = ins.entries.length;
        ins.entries = ins.entries.filter(entry => {
          if (!entry || isCursorOrConversation(entry)) return true;

          if (isAdEntry(entry)) {
            const item = entry.content?.itemContent || entry.item?.itemContent;
            if (item && item.legacy?.text && !item.promotedMetadata && !item.sponsoredMetadata && !entry.adEntity && !entry.ad) {
              console.log(`[X-Ad-Blocker-2026-v3] ⚠️ 防误杀: ${entry.entryId}`);
              return true;
            }
            modified = true;
            removedCount++;
            console.log(`[X-Ad-Blocker-2026-v3] ✅ 已删除广告: ${entry.entryId || 'unknown'} (type: ${entry.__typename || 'no-typename'})`);
            return false;
          }
          return true;
        });

        // 临时注释掉回滚（测试用）
        // if (ins.entries.length < originalLength * 0.5) { ... }  // 已关闭
      }

      if (Array.isArray(ins.moduleItems)) {
        // 同上处理 moduleItems（保持原逻辑）
        let originalModuleItems = [...ins.moduleItems];
        ins.moduleItems = ins.moduleItems.filter(mod => {
          if (!mod) return true;
          const itemContent = mod.item?.itemContent || mod.item?.item_content;
          if (itemContent && isAdEntry({content: {itemContent}})) {
            modified = true;
            removedCount++;
            console.log(`[X-Ad-Blocker-2026-v3] ✅ 已删除 module 广告`);
            return false;
          }
          return true;
        });
      }
    }

    if (modified) console.log(`[X-Ad-Blocker-2026-v3] 🎉 共清理 ${removedCount} 条广告！`);
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

    // 2026 最新路径（大幅增加）
    const paths = [
      {path: ['data','home','home_timeline_urt','instructions']},
      {path: ['data','home','home_timeline_urt_v2','instructions']},
      {path: ['data','home','home_timeline_urt_v3','instructions']},
      {path: ['data','home','timeline_v2','timeline','instructions']},
      {path: ['data','home','timeline_v3','timeline','instructions']},
      {path: ['data','home','timeline_v4','timeline','instructions']},
      {path: ['data','timeline','timeline_v2','instructions']},
      {path: ['data','timeline','timeline_v3','instructions']},
      {path: ['data','search_by_raw_query','search_timeline','timeline','instructions']},
      {path: ['data','user','result','timeline_v2','timeline','instructions']},
      {path: ['data','user','result','timeline_v3','timeline','instructions']},
      {path: ['data','userByScreenName','result','timeline_v2','timeline','instructions']},
      {path: ['data','userByScreenName','result','timeline_v3','timeline','instructions']},
      {path: ['data','viewer','home_timeline_urt','instructions']},           // 新增
      {path: ['data','for_you_timeline','instructions']}                     // 新增
    ];

    for (const {path} of paths) {
      let node = json;
      for (let i = 0; i < path.length; i++) {
        if (!node) break;
        node = node[path[i]];
      }
      if (Array.isArray(node)) {
        const res = processInstructionsEntries(node);
        if (res) changed = true;
      }
    }

    if (changed) {
      $done({ body: JSON.stringify(json) });
    } else {
      console.log('[X-Ad-Blocker-2026-v3] ⚠️ 没有匹配到任何路径或没有广告被删除，请检查重写规则！');
      $done({ body: raw });
    }
  } catch (err) {
    console.log(`[X-Ad-Blocker-2026-v3] Main error: ${err}`);
    $done({ body: $response.body || '' });
  }
})();