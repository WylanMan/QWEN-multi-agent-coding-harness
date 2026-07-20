(function () {
  'use strict';

  // Original DOM refs (for backward compatibility with old full-page tree view)
  var $treeView = document.getElementById('tree-view');
  var $treeCanvas = document.getElementById('tree-canvas');
  var $treeNodeCount = document.getElementById('tree-node-count');
  var $treeSearchInput = document.getElementById('tree-search-input');

  // Track the current rendering target and last data
  var _container = null;
  var _lastTreeData = null;
  var _lastOptions = null;

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatTokens(n) {
    if (!n || n <= 0) return '';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function getTypeIcon(type) {
    switch (type) {
      case 'master':
        return '\u{1F333}';
      case 'project':
        return '\u{1F4C1}';
      case 'feature':
        return '\u{1F527}';
      case 'subagent':
        return '\u{26A1}';
      default:
        return '\u{1F4C4}';
    }
  }

  function getTypeClass(type) {
    switch (type) {
      case 'master': return 'tree-node-type-master';
      case 'project': return 'tree-node-type-project';
      case 'feature': return 'tree-node-type-feature';
      case 'subagent': return 'tree-node-type-subagent';
      default: return 'tree-node-type-default';
    }
  }

  function hasActiveDescendant(node) {
    if (!node.children) return false;
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (child.isActive) return true;
      if (hasActiveDescendant(child)) return true;
    }
    return false;
  }

  function renderNode(node, depth, container, onSessionClick) {
    var hasChildren = node.children && node.children.length > 0;

    var row = document.createElement('div');
    row.className = 'tree-node-row' +
      (node.isActive ? ' active' : '') +
      ' ' + getTypeClass(node.type || '');
    row.id = 'tree-node-' + node.id;
    row.dataset.sessionId = node.id;

    // --- chevron ---
    var chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.textContent = hasChildren ? '\u25B6' : '';
    if (hasChildren) {
      chevron.style.cursor = 'pointer';
      chevron.style.fontSize = '10px';
      chevron.style.width = '14px';
      chevron.style.display = 'inline-block';
      chevron.style.transition = 'transform 0.15s';
    }

    // --- depth guides ---
    var indent = document.createElement('span');
    indent.style.display = 'inline-flex';
    for (var i = 0; i < depth; i++) {
      var guide = document.createElement('span');
      guide.className = 'tree-depth-guide';
      indent.appendChild(guide);
    }

    // --- icon ---
    var icon = document.createElement('span');
    icon.className = 'tree-node-icon';
    icon.textContent = getTypeIcon(node.type);

    // --- name ---
    var nameSpan = document.createElement('span');
    nameSpan.className = 'tree-node-name';
    nameSpan.textContent = escHtml(node.name || (node.id ? node.id.slice(0, 8) : ''));

    // --- mode badge ---
    var mode =
      node.forkMode && node.forkMode !== node.type ? node.forkMode : '';
    var modeSpan = document.createElement('span');
    modeSpan.className = 'tree-node-mode';
    modeSpan.textContent = escHtml(mode);

    // --- tokens ---
    var tokenSpan = document.createElement('span');
    tokenSpan.className = 'tree-node-tokens';
    tokenSpan.textContent = formatTokens(node.estimatedTokens);

    row.appendChild(chevron);
    row.appendChild(indent);
    row.appendChild(icon);
    row.appendChild(nameSpan);
    row.appendChild(modeSpan);
    row.appendChild(tokenSpan);

    // --- click handler ---
    row.addEventListener('click', function (e) {
      if (e.target === chevron) return;
      onSessionClick(node.id);
    });

    container.appendChild(row);

    // --- children ---
    if (hasChildren) {
      var childrenWrap = document.createElement('div');
      childrenWrap.className = 'tree-children';
      childrenWrap.style.display =
        node.isActive || hasActiveDescendant(node) ? 'block' : 'none';
      childrenWrap.id = 'tree-children-' + node.id;

      for (var j = 0; j < node.children.length; j++) {
        renderNode(node.children[j], depth + 1, childrenWrap, onSessionClick);
      }

      container.appendChild(childrenWrap);

      // Expand/collapse on chevron click
      chevron.addEventListener('click', function (e) {
        e.stopPropagation();
        var expanded = childrenWrap.style.display !== 'none';
        childrenWrap.style.display = expanded ? 'none' : 'block';
        chevron.style.transform = expanded ? 'rotate(0deg)' : 'rotate(90deg)';
      });

      // Auto-expand if active path
      if (node.isActive || hasActiveDescendant(node)) {
        childrenWrap.style.display = 'block';
        chevron.style.transform = 'rotate(90deg)';
      }
    }
  }

  // --- Restore default collapse state ---
  function restoreDefaultCollapseState(container) {
    var target = container || _container || $treeCanvas;
    if (!target) return;
    var childrenWraps = target.querySelectorAll('.tree-children');
    for (var i = 0; i < childrenWraps.length; i++) {
      var wrap = childrenWraps[i];
      var hasActive = wrap.querySelector('.tree-node-row.active') !== null;
      wrap.style.display = hasActive ? 'block' : 'none';

      var parentId = wrap.id.replace('tree-children-', '');
      var parentRow = document.getElementById('tree-node-' + parentId);
      if (parentRow) {
        var chevron = parentRow.querySelector('.tree-chevron');
        if (chevron) {
          chevron.style.transform = hasActive ? 'rotate(90deg)' : 'rotate(0deg)';
        }
      }
    }
  }

  // --- Search filter ---
  function filterTree(searchText) {
    var target = _container || $treeCanvas;
    if (!target) return;

    if (!searchText || !searchText.trim()) {
      var allRows = target.querySelectorAll('.tree-node-row');
      for (var i = 0; i < allRows.length; i++) {
        allRows[i].style.display = '';
      }
      restoreDefaultCollapseState(target);
      return;
    }

    var query = searchText.trim().toLowerCase();

    var rows = target.querySelectorAll('.tree-node-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var nameEl = row.querySelector('.tree-node-name');
      var name = nameEl ? nameEl.textContent.toLowerCase() : '';

      if (name.indexOf(query) !== -1) {
        row.style.display = '';
        row.style.opacity = '1';
        showAncestors(row, target);
      } else {
        row.style.display = 'none';
      }
    }
  }

  function showAncestors(row, target) {
    var parent = row.parentElement;
    while (parent && parent !== target) {
      if (parent.classList && parent.classList.contains('tree-children')) {
        parent.style.display = 'block';
        var parentId = parent.id.replace('tree-children-', '');
        var parentRow = document.getElementById('tree-node-' + parentId);
        if (parentRow) {
          var chevron = parentRow.querySelector('.tree-chevron');
          if (chevron) {
            chevron.style.transform = 'rotate(90deg)';
          }
        }
      }
      parent = parent.parentElement;
    }
  }

  // --- Highlight active session ---
  function highlightActive(sessionId) {
    var target = _container || $treeCanvas;
    if (!target) return;

    // Remove active from all rows
    var allRows = target.querySelectorAll('.tree-node-row');
    for (var i = 0; i < allRows.length; i++) {
      allRows[i].classList.remove('active');
    }

    // Add active to matching row, expand ancestors
    if (sessionId) {
      var activeRow = target.querySelector('#tree-node-' + sessionId);
      if (activeRow) {
        activeRow.classList.add('active');
        expandAncestors(activeRow, target);
      }
    }
  }

  function expandAncestors(row, target) {
    var parent = row.parentElement;
    while (parent && parent !== target) {
      if (parent.classList && parent.classList.contains('tree-children')) {
        parent.style.display = 'block';
        var parentId = parent.id.replace('tree-children-', '');
        var parentRow = document.getElementById('tree-node-' + parentId);
        if (parentRow) {
          var chevron = parentRow.querySelector('.tree-chevron');
          if (chevron) {
            chevron.style.transform = 'rotate(90deg)';
          }
        }
      }
      parent = parent.parentElement;
    }
  }

  // --- Public API ---

  function renderTree(treeData, options) {
    _lastTreeData = treeData;
    _lastOptions = options;

    var onSessionClick =
      (options && options.onSessionClick) ||
      function (id) {
        if (window.send) {
          window.send({ type: 'switch_session', sessionId: id });
        }
        hide();
      };

    // Use provided container or fall back to original $treeCanvas
    var container = (options && options.container) || $treeCanvas;
    _container = container;
    if (!container) return;

    container.innerHTML = '';

    if (!treeData || treeData.length === 0) {
      container.innerHTML =
        '<div class="tree-empty">No sessions yet</div>';
      if ($treeNodeCount) $treeNodeCount.textContent = '0 sessions';
      if ($treeSearchInput) $treeSearchInput.value = '';
      return;
    }

    var totalNodes = 0;

    for (var i = 0; i < treeData.length; i++) {
      renderNode(treeData[i], 0, container, onSessionClick);
      countNodes(treeData[i]);
    }

    if ($treeNodeCount) {
      $treeNodeCount.textContent =
        totalNodes + ' session' + (totalNodes !== 1 ? 's' : '');
    }

    function countNodes(node) {
      totalNodes++;
      if (node.children) {
        for (var k = 0; k < node.children.length; k++) {
          countNodes(node.children[k]);
        }
      }
    }
  }

  function show() {
    if ($treeView) $treeView.classList.remove('hidden');
    if ($treeSearchInput) setTimeout(function () { $treeSearchInput.focus(); }, 100);
  }

  function hide() {
    if ($treeView) $treeView.classList.add('hidden');
  }

  function toggle() {
    if ($treeView) $treeView.classList.toggle('hidden');
    if (!$treeView.classList.contains('hidden')) {
      if ($treeSearchInput) setTimeout(function () { $treeSearchInput.focus(); }, 100);
    }
  }

  // ── Wire search input (old full-page tree view) ─────────────────
  function initSearch() {
    if (!$treeSearchInput) return;

    $treeSearchInput.addEventListener('input', function () {
      filterTree($treeSearchInput.value);
    });

    $treeSearchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        $treeSearchInput.value = '';
        filterTree('');
        $treeSearchInput.blur();
      }
    });
  }

  // Auto-init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSearch);
  } else {
    initSearch();
  }

  // --- Flat list renderer for independent sessions ---
  function renderFlatList(sessionsArray, options) {
    var container = (options && options.container) || _container || $treeCanvas;
    if (!container) return;
    _container = container;
    container.innerHTML = '';
    var activeId = (options && options.activeSessionId) || '';
    var onSessionClick = (options && options.onSessionClick) || function () {};

    if (!sessionsArray || sessionsArray.length === 0) {
      container.innerHTML = '<div class="tree-empty">No sessions yet</div>';
      return;
    }

    for (var i = 0; i < sessionsArray.length; i++) {
      var s = sessionsArray[i];
      var row = document.createElement('div');
      row.className = 'tree-row session-row' + (s.id === activeId ? ' active' : '');
      row.id = 'tree-node-' + s.id;
      row.dataset.sessionId = s.id;
      var tokensHtml = s.estimatedTokens ? '<span class="tree-tokens">' + escHtml(String(Math.round(s.estimatedTokens / 1000))) + 'k</span>' : '';
      row.innerHTML =
        '<span class="tree-icon">📁</span>' +
        '<span class="tree-name">' + escHtml(s.name || 'Untitled') + '</span>' +
        '<span class="tree-meta">' + escHtml(s.cwd || '') + '</span>' +
        tokensHtml;
      row.addEventListener('click', (function (id) {
        return function () { onSessionClick(id); };
      })(s.id));
      container.appendChild(row);
    }
  }

  window.TreeView = {
    renderTree: renderTree,
    renderFlatList: renderFlatList,
    show: show,
    hide: hide,
    toggle: toggle,
    filter: filterTree,
    highlightActive: highlightActive,
    restoreDefaultCollapse: restoreDefaultCollapseState,
  };
})();
