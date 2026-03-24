// ==UserScript==
// @name         Copy Markdown GitHub
// @namespace    http://tampermonkey.net/
// @version      2026-03-24
// @description  Add a "Copy Markdown" item to the GitHub comment menu
// @author       dmkt9
// @match        https://github.com/*/*/pull/*
// @match        https://github.com/*/*/issues/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=github.com
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";
  const MENU_ITEM_CLASS = "js-comment-copy-markdown";
  const UUID_REGEX = /\/\d+-([^-]+-[^-]+-[^-]+-[^-]+-[^-]+)\.\S{1,4}(?:\?|$)/;

  function indexInList(li) {
    const parent = li.parentNode;
    if (parent === null || !(parent instanceof HTMLElement)) throw new Error();
    let start = 0;
    if (parent instanceof HTMLOListElement && parent.start !== 1) {
      start = parent.start - 1;
    }
    const ref = parent.children;
    for (let i = 0; i < ref.length; ++i) {
      if (ref[i] === li) {
        return start + i;
      }
    }
    return start;
  }
  function skipNode(node) {
    if (node instanceof HTMLAnchorElement && node.childNodes.length === 1) {
      const first = node.childNodes[0];
      if (first instanceof HTMLImageElement) {
        return first.src === node.href;
      }
    }
    return false;
  }
  function hasContent(node) {
    return node.nodeName === "IMG" || node.firstChild != null;
  }
  function isCheckbox(node) {
    return (
      node.nodeName === "INPUT" &&
      node instanceof HTMLInputElement &&
      node.type === "checkbox"
    );
  }
  let listIndexOffset = 0;
  function nestedListExclusive(li) {
    const first = li.childNodes[0];
    const second = li.childNodes[1];
    if (first && li.childNodes.length < 3) {
      return (
        (first.nodeName === "OL" || first.nodeName === "UL") &&
        (!second ||
          (second.nodeType === Node.TEXT_NODE &&
            !(second.textContent || "").trim()))
      );
    }
    return false;
  }
  function escapeAttribute(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/'/g, "&apos;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function getUUIDFromSrc(src) {
    return UUID_REGEX.exec(src ?? "")?.at(1);
  }
  const filters = {
    INPUT(el) {
      if (el instanceof HTMLInputElement && el.checked) {
        return "[x] ";
      }
      return "[ ] ";
    },
    CODE(el) {
      const text = el.textContent || "";
      if (el.parentNode && el.parentNode.nodeName === "PRE") {
        el.textContent = `\`\`\`\n${text.replace(/\n+$/, "")}\n\`\`\`\n\n`;
        return el;
      }
      if (text.indexOf("`") >= 0) {
        return `\`\` ${text} \`\``;
      }
      return `\`${text}\``;
    },
    P(el) {
      const pElement = document.createElement("p");
      const text = el.textContent || "";
      pElement.textContent =
        text.replace(/<(\/?)(pre|strong|weak|em)>/g, "\\<$1$2\\>") + "\n";
      return pElement;
    },
    STRONG(el) {
      return `**${el.textContent || ""}**`;
    },
    EM(el) {
      return `_${el.textContent || ""}_`;
    },
    DEL(el) {
      return `~${el.textContent || ""}~`;
    },
    BLOCKQUOTE(el) {
      const text = (el.textContent || "").trim().replace(/^/gm, "> ");
      const pre = document.createElement("pre");
      pre.textContent = `${text}\n\n`;
      return pre;
    },
    A(el) {
      const text = el.textContent || "";
      const href = el.getAttribute("href");
      if (/^https?:/.test(text) && text === href) {
        return text;
      } else {
        if (href) {
          return `[${text}](${href})`;
        } else {
          return text;
        }
      }
    },
    IMG(el) {
      const alt = el.getAttribute("alt") || "";
      const src = el.getAttribute("src");
      const uuid = getUUIDFromSrc(src);
      if (!src && !uuid) throw new Error();
      const widthAttr = el.hasAttribute("width")
        ? ` width="${escapeAttribute(el.getAttribute("width") || "")}"`
        : "";
      const heightAttr = el.hasAttribute("height")
        ? ` height="${escapeAttribute(el.getAttribute("height") || "")}"`
        : "";
      const newSrc = uuid
        ? `https://github.com/user-attachments/assets/${uuid}`
        : escapeAttribute(src);
      if (widthAttr || heightAttr) {
        return `<img alt="${escapeAttribute(alt)}"${widthAttr}${heightAttr} src="${newSrc}">`;
      } else {
        return `![${alt}](${newSrc})`;
      }
    },
    VIDEO(el) {
      const src = el.getAttribute("src");
      const uuid = getUUIDFromSrc(src);
      if (!uuid && !src) throw new Error();
      return uuid
        ? `https://github.com/user-attachments/assets/${uuid}`
        : escapeAttribute(src);
    },
    LI(el) {
      const list = el.parentNode;
      if (!list) throw new Error();
      let bullet = "";
      if (!nestedListExclusive(el)) {
        if (list.nodeName === "OL") {
          if (listIndexOffset > 0 && !list.previousSibling) {
            const num = indexInList(el) + listIndexOffset + 1;
            bullet = `${num}\\. `;
          } else {
            bullet = `${indexInList(el) + 1}. `;
          }
        } else {
          bullet = "* ";
        }
      }
      const indent = bullet.replace(/\S/g, " ");
      const text = (el.textContent || "").trim().replace(/^/gm, indent);
      const pre = document.createElement("pre");
      pre.textContent = text.replace(indent, bullet);
      return pre;
    },
    OL(el) {
      const li = document.createElement("li");
      li.appendChild(document.createElement("br"));
      el.append(li);
      return el;
    },
    H1(el) {
      const level = parseInt(el.nodeName.slice(1));
      el.prepend(`${Array(level + 1).join("#")} `);
      return el;
    },
    UL(el) {
      return el;
    },
    DETAILS(el) {
      el.prepend("<details>\n");
      el.append("</details>");
      return el;
    },
    SUMMARY(el) {
      el.prepend("<summary>");
      el.append("</summary>");
      return el;
    },
  };
  filters.UL = filters.OL;
  for (let level = 2; level <= 6; ++level) {
    filters[`H${level}`] = filters.H1;
  }
  function insertMarkdownSyntax(root) {
    root.innerHTML = root.innerHTML
      .replaceAll(/(<(?:ul|ol)[^>]*>)\s*\n+\s*(<li[^>]*>)/gm, "$1$2")
      .replaceAll(
        /\s*<details(?:(?!<details)[\s\S])*?(<video[\s\S]*?<\/video>)(?:(?!<details)[\s\S])*?<\/details>/gm,
        "\n\n$1\n",
      );
    const nodeIterator = document.createNodeIterator(
      root,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (
            node.nodeName in filters &&
            !skipNode(node) &&
            (hasContent(node) || isCheckbox(node))
          ) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        },
      },
    );
    const results = [];
    let node = nodeIterator.nextNode();
    while (node) {
      if (node instanceof HTMLElement) {
        results.push(node);
      }
      node = nodeIterator.nextNode();
    }
    results.reverse();
    for (const el of results) {
      el.replaceWith(filters[el.nodeName](el));
    }
  }

  function closeMenu(menuList) {
    const overlay = menuList.closest('[data-component="AnchoredOverlay"]');
    if (overlay) {
      overlay.remove();
    }

    const details = menuList.closest("details");
    if (details) {
      details.removeAttribute("open");
    }
  }

  async function performCopy(menuList) {
    const allContainerElements = document.querySelectorAll(
      "div.timeline-comment-group.js-minimizable-comment-group",
    );

    const menuParent = Array.from(allContainerElements).find((element) =>
      element.contains(menuList),
    );

    if (!menuParent) {
      alert("Something went wrong.");
      return;
    }

    const bodyElement = menuParent.querySelector(
      ".comment-body.markdown-body.js-comment-body",
    );
    if (!(bodyElement instanceof HTMLElement)) {
      alert("Could not find the comment body.");
      return;
    }

    try {
      const clone = bodyElement.cloneNode(true);
      insertMarkdownSyntax(clone);
      await navigator.clipboard.writeText(clone.textContent.trim());
      closeMenu(menuList);
    } catch (err) {
      alert("Failed to copy Markdown.");
      console.error("Copy failed", err);
    }
  }

  function addToCommentMenu(menuList) {
    if (
      menuList.querySelector(`.${MENU_ITEM_CLASS}`) ||
      !menuList.querySelector("clipboard-copy.dropdown-item.btn-link")
    ) {
      return;
    }

    const newButton = document.createElement("button");
    newButton.className = `dropdown-item btn-link ${MENU_ITEM_CLASS}`;
    newButton.setAttribute("role", "menuitem");
    newButton.setAttribute("type", "button");
    newButton.innerText = "Copy Markdown";

    newButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      performCopy(menuList);
    });

    const quoteReplyBtn = menuList.querySelector(".js-comment-quote-reply");

    if (quoteReplyBtn) {
      quoteReplyBtn.before(newButton);
    } else {
      menuList.append(newButton);
    }

    console.debug("[TM] Added Copy Markdown menu item", menuList);
  }

  function mutationHandler(mutation) {
    if (mutation.target.tagName === "DETAILS-MENU") {
      if (!mutation.target.querySelector(`.${MENU_ITEM_CLASS}`)) {
        addToCommentMenu(mutation.target);
      }
    }

    mutation.addedNodes.forEach((node) => {
      if (node.tagName === "DETAILS-MENU") {
        if (!node.querySelector(`.${MENU_ITEM_CLASS}`)) {
          addToCommentMenu(node);
        }
      }
      if (!node.querySelectorAll) {
        return;
      }
      node.querySelectorAll("details-menu").forEach((detailsMenu) => {
        if (detailsMenu.querySelector(`.${MENU_ITEM_CLASS}`)) {
          return;
        }
        addToCommentMenu(detailsMenu);
      });
    });
  }

  (function start() {
    // enable the copy markdown feature for the issue pages
    if (window.location.href.match(/github\.com\/[^\/]+\/[^\/]+\/issues\//)) {
      const originalParse = JSON.parse;

      JSON.parse = function (str, ...args) {
        try {
          if (typeof str === "string" && str.includes("featureFlags")) {
            const obj = originalParse(str, ...args);

            if (obj?.featureFlags && Array.isArray(obj.featureFlags)) {
              if (
                !obj.featureFlags.includes("comment_viewer_copy_raw_markdown")
              ) {
                obj.featureFlags.push("comment_viewer_copy_raw_markdown");
                console.debug("[TM] Injected comment_viewer_copy_raw_markdown");
              }
            }

            return obj;
          }
        } catch (error) {
          console.error("[TM] Failed to patch feature flags", error);
        }

        return originalParse(str, ...args);
      };
      return;
    }

    const menus = document.querySelectorAll("details-menu");
    menus.forEach(addToCommentMenu);

    const observer = new MutationObserver((mutations) => {
      mutations.forEach(mutationHandler);
    });

    setTimeout(function handler() {
      if (document.body === null) {
        setTimeout(handler, 500);
        return;
      }
      const menus = document.querySelectorAll("details-menu");
      menus.forEach(addToCommentMenu);

      observer.observe(document.body, { childList: true, subtree: true });
    }, 500);
  })();
})();
