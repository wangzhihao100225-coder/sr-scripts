// ==UserScript==
// @name         X (Twitter) 去广告 - 高可用终极版
// @description  整合多语言正则检测、Timeline彻底过滤、Thread防断层保护与安全回滚机制
// ==/UserScript==

(function() {
  'use strict';

  function safeParse(body) {
    try { return JSON.parse(body); } catch (e) { return null; }
  }
  
  function isString(v){ return typeof v === 'string'; }

  // 增强广告检测：多语言正则
  const adKeywordsRegex = /Promoted|Gesponsert|Promocionado|Sponsorisé|Sponsorizzato|Promowane|Promovido|Реклама|Uitgelicht|Sponsorlu|Promotert|Promoveret|Sponsrad|Mainostettu|Sponzorováno|Promovat|Ajánlott|Προωθημένο|Dipromosikan|Được quảng bá|推廣|推广|推薦|推荐|プロモーション|프로모션|ประชาสัมพันธ์|प्रचारित|বিজ্ঞাপিত|تشہیر شدہ|مُروَّج|تبلیغی|מקודם|Ad|Sponsored|Boosted/i;

  function isAdEntry(entry, isThread = false) {
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

    // 内部字段检查
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
        if (!isThread && (item.card || item.card_uri || item.card_id)) return true;
      }
    } catch (e) {}

    // Top-level字段
    if (entry.ad || entry.adEntity || entry.advertisement || entry.sponsored) return true;
    if (!isThread && (entry.card || entry.card_uri)) return true;

    // 数据类型映射
    if (entry.__typename && (entry.__typename.includes('Promoted') || entry.__typename.includes('Ad'))) return true;

    return false;
  }

  // 保护cursor/conversation等分页与上下文机制
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

  // 中和：浅拷贝保留结构，只删广告字段（用于Thread防断层）
  function neutralizeAdEntry(entry, isThread = false) {
    try {
      const shell = { ...entry }; 
      if (shell.content?.itemContent) {
        delete shell.content.itemContent.promotedMetadata;
        delete shell.content.itemContent.promoted_metadata;
        delete shell.content.itemContent.promoted;
        delete shell.content.itemContent.advertisement;
        delete shell.content.itemContent.adEntity;
        delete shell.content.itemContent.ad;
        delete shell.content.itemContent.sponsoredMetadata;
        delete shell.content.itemContent.boosted;
        delete shell.content.itemContent.ad_info;
        delete shell.content.itemContent.promotion;
      }
      if (shell.ad || shell.adEntity || shell.advertisement || shell.sponsored) {
        delete shell.ad;
        delete shell.adEntity;
        delete shell.advertisement;
        delete shell.sponsored;
      }
      return shell;
    } catch (e) {
      console.log(`Neutralize error: ${e}`);
      return entry;
    }
  }

  // 核心处理逻辑 (优化版)
  function processInstructionsEntries(instructions, isThread = false) {
    if (!Array.isArray(instructions)) return false;
    let modified = false;
    let removedCount = 0;

    // 配置：thread中是否激进去除（默认保守 false，防止评论树断裂）
    const aggressiveThreadMode = false;

    for (const ins of instructions) {
      if (!ins || typeof ins !== 'object') continue;

      // --- 处理 Entries ---
      if (Array.isArray(ins.entries)) {
        let originalEntries; // 提升作用域，确保 catch 能够访问到进行回滚
        try {
          originalEntries = [...ins.entries]; 
          const originalLength = ins.entries.length;

          ins.entries = ins.entries.filter(entry => {
            if (!entry || isCursorOrConversation(entry)) return true;

            if (isAdEntry(entry, isThread)) {
              // 极端的误杀防范：如果被判定为广告，但没有任何官方广告标签，且包含正文，予以放行
              const item = entry.content?.itemContent || entry.item?.itemContent;
              if (item && item.legacy?.text && !item.promotedMetadata && !item.sponsoredMetadata && !entry.adEntity) {
                 console.log(`Potential miskill avoided: ${entry.entryId}`);
                 return true;
              }

              modified = true;
              removedCount++;
              
              if (isThread && !aggressiveThreadMode) {
                return true; // Thread保守模式：保留在数组中，交给后面的 map 去中和
              }
              console.log(`Removed ad entry completely: ${entry.entryId}`);
              return false; // Timeline 模式：彻底从数组中移除
            }
            return true; 
          });

          // Fallback回滚机制：如果单次请求被移除的数据超过 50%，且总数据量大于 4 条，触发安全回滚防崩溃
          if (originalLength > 4 && ins.entries.length < originalLength * 0.5) {
            console.log(`Warning: Too many removals (${removedCount}/${originalLength}), partial rollback triggered.`);
            ins.entries = originalEntries; 
            modified = false; 
            removedCount = 0;
          }

          // 处理保守模式下保留的广告（去标不去底，保证 Thread 上下文不断裂）
          if (isThread && modified && !aggressiveThreadMode) {
            ins.entries = ins.entries.map(entry => {
              if (isAdEntry(entry, true)) {
                return neutralizeAdEntry(entry, true);
              }
              return entry;
            });
          }
        } catch (e) {
          console.log(`Entries process error: ${e}`);
          if (originalEntries) ins.entries = originalEntries; // 异常时安全回滚
        }
      }

      // --- 处理 Module Items (如“可能感兴趣的用户”模块中的广告) ---
      if (Array.isArray(ins.moduleItems)) {
        let originalModuleItems;
        try {
          originalModuleItems = [...ins.moduleItems];
          const originalModLength = ins.moduleItems.length;

          ins.moduleItems = ins.moduleItems.filter(mod => {
            if (!mod) return true;
            const itemContent = mod.item?.itemContent || mod.item?.item_content;
            if (itemContent && (itemContent.promotedMetadata || itemContent.adEntity || itemContent.ad || itemContent.sponsoredMetadata)) {
              modified = true;
              removedCount++;
              console.log(`Removed ad module completely: ${mod.id || 'unknown'}`);
              return false;
            }
            return true;
          });

          if (originalModLength > 2 && ins.moduleItems.length < originalModLength * 0.5) {
            console.log(`Warning: Too many module removals, rollback triggered.`);
            ins.moduleItems = originalModuleItems;
          }
        } catch (e) {
          console.log(`Module process error: ${e}`);
          if (originalModuleItems) ins.moduleItems = originalModuleItems;
        }
      }
    }

    if (modified) console.log(`Total modifications: ${removedCount} items processed (isThread: ${isThread})`);
    return modified;
  }

  // --- 主执行入口 ---
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

    // 遍历所有可能的 X 数据下发路径
    const paths = [
      {path: ['data','home','home_timeline_urt','instructions'], isThread: false},
      {path: ['data','home','home_timeline_urt_v2','instructions'], isThread: false},
      {path: ['data','home','timeline_v2','timeline','instructions'], isThread: false},
      {path: ['data','home','timeline_v3','timeline','instructions'], isThread: false},
      {path: ['data','timeline','timeline_v2','instructions'], isThread: false},
      {path: ['data','search_by_raw_query','search_timeline','timeline','instructions'], isThread: false},
      {path: ['data','user','result','timeline_v2','timeline','instructions'], isThread: false},
      {path: ['data','threaded_conversation_with_injections_v2','instructions'], isThread: true},
      {path: ['data','threaded_conversation_with_injections','instructions'], isThread: true}
    ];

    for (const {path, isThread} of paths) {
      let node = json;
      for (let i = 0; i < path.length; i++) {
        if (!node) break;
        node = node[path[i]];
      }
      if (Array.isArray(node)) {
        try {
          const res = processInstructionsEntries(node, isThread);
          if (res) changed = true;
        } catch (e) {
          console.log(`Path process error: ${e}`);
        }
      }
    }

    if (changed) {
      $done({ body: JSON.stringify(json) });
    } else {
      $done({ body: raw });
    }
  } catch (err) {
    console.log(`Main error: ${err}`);
    $done({ body: $response.body || '' });
  }
})();