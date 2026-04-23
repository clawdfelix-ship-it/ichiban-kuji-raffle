// ============================================
// Ichiban Kuji Proxy - Frontend JavaScript
// ============================================

// Global variables for raffle page
let currentRaffleId = null;

// Utility functions
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function apiRequest(url, options = {}) {
  const hasFormData = options.body instanceof FormData;
  const headers = { ...(options.headers || {}) };
  if (!hasFormData && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, { ...options, headers });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || '發生錯誤');
  }
  return data;
}

// ============================================
// Public Raffle Page
// ============================================
function initRafflePage(raffleId) {
  currentRaffleId = raffleId;

  const form = document.getElementById('drawForm');
  const modal = document.getElementById('resultModal');
  const closeBtn = document.getElementById('closeResult');
  const resultContent = document.getElementById('resultContent');

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const code = document.getElementById('verification_code').value.trim();
      const username = document.getElementById('username').value.trim();
      const contact = document.getElementById('contact').value.trim();
      const drawBtn = document.getElementById('drawBtn');

      if (!code) {
        alert('請輸入驗證碼');
        return;
      }
      if (!username || !contact) {
        alert('請填寫會員用戶名和聯絡方式');
        return;
      }

      drawBtn.disabled = true;
      drawBtn.textContent = '處理中...';

      try {
        const result = await apiRequest(`/api/raffle/${currentRaffleId}/draw`, {
          method: 'POST',
          body: JSON.stringify({ 
            username, 
            contact, 
            code
          }),
        });

        // Show result
        let html = `
          <div class="result-item ${result.item.is_final ? 'final-result' : ''}">
            ${result.item.is_final ? '🎉 獲得最終賞! 🎉<br>' : ''}
            ${escapeHtml(result.item.name)}
          </div>
          <p>委託完成，請保留截圖並聯絡商家領取商品</p>
        `;
        resultContent.innerHTML = html;
        modal.classList.remove('hidden');

        // Reload page after close to update counts
        closeBtn.addEventListener('click', () => {
          modal.classList.add('hidden');
          window.location.reload();
        }, { once: true });

      } catch (err) {
        alert(err.message);
      } finally {
        drawBtn.disabled = false;
        drawBtn.textContent = '確認驗證碼，提交委託!';
      }
    });
  }

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });

    // Click outside to close
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  // Batch mode toggle
  const batchToggle = document.getElementById('batchModeToggle');
  const singleForm = document.getElementById('drawForm');
  const batchForm = document.getElementById('batchDrawForm');
  const batchResultsArea = document.getElementById('batchResultsArea');
  const batchResultsContent = document.getElementById('batchResultsContent');
  const batchCountSpan = document.getElementById('batchCount');
  const batchTextarea = document.getElementById('batch_codes');

  if (batchToggle) {
    batchToggle.addEventListener('change', () => {
      if (batchToggle.checked) {
        singleForm.style.display = 'none';
        batchForm.style.display = 'block';
        batchResultsArea.style.display = 'block';
      } else {
        singleForm.style.display = 'block';
        batchForm.style.display = 'none';
        batchResultsArea.style.display = 'none';
      }
    });
  }

  // Update batch count when text changes
  if (batchTextarea) {
    batchTextarea.addEventListener('input', () => {
      const text = batchTextarea.value.trim();
      if (!text) {
        batchCountSpan.textContent = '0';
        return;
      }
      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      batchCountSpan.textContent = String(lines.length);
    });
  }

  // Batch draw form submit
  if (batchForm) {
    batchForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const text = document.getElementById('batch_codes').value.trim();
      const username = document.getElementById('batch_username').value.trim();
      const contact = document.getElementById('batch_contact').value.trim();
      const drawBtn = document.getElementById('batchDrawBtn');

      if (!text) {
        alert('請輸入驗證碼');
        return;
      }
      if (!username || !contact) {
        alert('請填寫會員用戶名和聯絡方式');
        return;
      }

      // 支援兩種格式：換行分隔 或 逗號分隔
      let codes;
      if (text.includes(',')) {
        // Comma separated
        codes = text.split(',').map(l => l.trim()).filter(l => l);
      } else {
        // Newline separated
        codes = text.split('\n').map(l => l.trim()).filter(l => l);
      }
      if (codes.length === 0) {
        alert('沒有有效的驗證碼');
        return;
      }
      if (codes.length > 50) {
        alert('批量處理最多支持 50 個驗證碼');
        return;
      }

      if (!confirm(`確定要提交 ${codes.length} 個批量委託嗎？此操作無法復原。`)) {
        return;
      }

      drawBtn.disabled = true;
      drawBtn.textContent = `批量處理進行中... 0/${codes.length}`;
      batchResultsContent.innerHTML = '<p>正在處理，請稍候...</p>';

      try {
        const result = await apiRequest(`/api/raffle/${currentRaffleId}/batch-draw`, {
          method: 'POST',
          body: JSON.stringify({
            codes,
            username,
            contact
          }),
        });

        // Build results HTML
        let html = `
          <div style="margin-bottom: 16px; padding: 12px; background: #f0f9ff; border-radius: 8px;">
            <strong>完成結果:</strong> ${result.successCount} / ${result.total} 成功
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr style="background: #fafafa;">
                <th style="padding: 8px; border-bottom: 1px solid #eee; text-align: left;">#</th>
                <th style="padding: 8px; border-bottom: 1px solid #eee; text-align: left;">驗證碼</th>
                <th style="padding: 8px; border-bottom: 1px solid #eee; text-align: left;">結果</th>
              </tr>
            </thead>
            <tbody>
        `;

        result.results.forEach((item, index) => {
          const statusStyle = item.success
            ? 'background: #f0fdf4; color: #166534;'
            : 'background: #fef2f2; color: #991b1b;';
          const resultText = item.success
            ? `✅ ${escapeHtml(item.prize.name)}${item.prize.is_final ? ' (最終賞)' : ''}`
            : `❌ ${escapeHtml(item.error)}`;

          html += `
            <tr>
              <td style="padding: 8px; border-bottom: 1px solid #eee;">${index + 1}</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee; font-family: monospace;">${escapeHtml(item.code)}</td>
              <td style="padding: 8px; border-bottom: 1px solid #eee;"><span style="padding: 4px 8px; border-radius: 4px; ${statusStyle}">${resultText}</span></td>
            </tr>
          `;
        });

        html += `
            </tbody>
          </table>
          <div style="margin-top: 16px;">
            <button id="reloadAfterBatch" class="btn btn-secondary">重新整理頁面更新商品剩餘數</button>
          </div>
        `;

        batchResultsContent.innerHTML = html;

        document.getElementById('reloadAfterBatch').addEventListener('click', () => {
          window.location.reload();
        });

      } catch (err) {
        batchResultsContent.innerHTML = `<p style="color: red;">錯誤: ${escapeHtml(err.message)}</p>`;
        alert(err.message);
      } finally {
        drawBtn.disabled = false;
        drawBtn.textContent = `開始批量委託 (${codes.length} 個)`;
      }
    });
  }
}

// ============================================
// Admin Dashboard
// ============================================
function initAdminDashboard() {
  document.querySelectorAll('.change-status').forEach(btn => {
    btn.addEventListener('click', async () => {
      const raffleId = btn.dataset.id;
      const newStatus = btn.dataset.status;

      const action = newStatus === 'active' ? '開啟' : '關閉';
      if (!confirm(`確定要${action}此代抽服務嗎?`)) {
        return;
      }

      try {
        await apiRequest(`/api/admin/raffles/${raffleId}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: newStatus }),
        });
        window.location.reload();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  const resetBtn = document.getElementById('resetRafflesBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      if (!confirm('確定要重置代抽服務列表嗎？此操作會刪除所有服務、商品、驗證碼及委託記錄。')) {
        return;
      }
      const token = prompt('請輸入重置 Token（Vercel env: ADMIN_RESET_TOKEN）');
      if (!token) return;
      resetBtn.disabled = true;
      try {
        await apiRequest('/api/admin/reset', {
          method: 'POST',
          body: JSON.stringify({ token, confirm: 'RESET' })
        });
        alert('重置完成');
        window.location.reload();
      } catch (err) {
        alert(err.message);
      } finally {
        resetBtn.disabled = false;
      }
    });
  }
}

// ============================================
// Verification Codes Modal (Admin)
// ============================================
let currentRaffleIdForCodes = null;

function initCodesModal() {
  const modal = document.getElementById('codesModal');
  const closeBtn = document.getElementById('closeCodesModal');
  const generateBtn = document.getElementById('generateBtn');

  // Open modal when clicking codes button
  document.querySelectorAll('.view-codes').forEach(btn => {
    btn.addEventListener('click', () => {
      currentRaffleIdForCodes = parseInt(btn.dataset.id);
      document.getElementById('codesModalTitle').textContent = 
        `驗證碼管理 - ${btn.dataset.title}`;
      modal.classList.remove('hidden');
      loadCodes();
    });
  });

  // Close modal
  closeBtn.addEventListener('click', () => {
    modal.classList.add('hidden');
  });

  // Click outside to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
    }
  });

  // Generate new codes
  generateBtn.addEventListener('click', async () => {
    if (!currentRaffleIdForCodes) return;

    const count = parseInt(document.getElementById('generateCount').value);
    if (!count || count < 1) {
      alert('請輸入正確數量');
      return;
    }

    try {
      const result = await apiRequest(`/api/admin/raffles/${currentRaffleIdForCodes}/generate-codes`, {
        method: 'POST',
        body: JSON.stringify({ count })
      });

      alert(`成功生成 ${result.count} 個驗證碼`);
      loadCodes();
      document.getElementById('generateCount').value = 1;
    } catch (err) {
      alert(err.message);
    }
  });

  async function loadCodes() {
    if (!currentRaffleIdForCodes) return;

    try {
      const result = await apiRequest(`/api/admin/raffles/${currentRaffleIdForCodes}/codes`);
      const codes = result.codes;
      const listEl = document.getElementById('codesList');
      const countEl = document.getElementById('codesCount');

      countEl.textContent = codes.length;

      if (codes.length === 0) {
        listEl.innerHTML = '<div class="empty-state"><p>尚未生成任何驗證碼</p></div>';
        return;
      }

      let html = '<div class="codes-table-wrapper"><table class="codes-table"><thead><tr><th>驗證碼</th><th>狀態</th><th>生成時間</th></tr></thead><tbody>';

      codes.forEach(code => {
        const status = code.used ? '已使用' : '未使用';
        const statusClass = code.used ? 'used' : 'unused';
        html += `
          <tr>
            <td><code class="code-text">${escapeHtml(code.code)}</code></td>
            <td><span class="status-badge ${statusClass}">${status}</span></td>
            <td>${new Date(code.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</td>
          </tr>
        `;
      });

      html += '</tbody></table></div>';
      listEl.innerHTML = html;
    } catch (err) {
      alert(err.message);
    }
  }
}

// ============================================
// Create Raffle Page (Wizard)
// ============================================
let itemsAdded = [];
let editingItemId = null;

function initCreateRafflePage() {
  // Step 1: Basic info
  const basicForm = document.getElementById('basicInfoForm');
  const isFinalCheckbox = document.getElementById('is_final');
  const poolNumberGroup = document.getElementById('poolNumberGroup');
  const coverFileInput = document.getElementById('cover_image_file');
  const coverUrlInput = document.getElementById('cover_image_url');
  const coverPreview = document.getElementById('coverPreview');
  const coverPreviewImg = document.getElementById('coverPreviewImg');
  const uploadCoverBtn = document.getElementById('uploadCoverBtn');
  const uploadStatus = document.getElementById('uploadStatus');

  if (coverFileInput && coverPreview && coverPreviewImg) {
    coverFileInput.addEventListener('change', () => {
      const file = coverFileInput.files && coverFileInput.files[0];
      if (!file) {
        coverPreview.style.display = 'none';
        coverPreviewImg.removeAttribute('src');
        return;
      }
      coverPreview.style.display = 'block';
      coverPreviewImg.src = URL.createObjectURL(file);
    });
  }

  // Upload cover image to server
  if (uploadCoverBtn) {
    uploadCoverBtn.addEventListener('click', async () => {
      const file = coverFileInput.files && coverFileInput.files[0];
      if (!file) {
        alert('請先選擇一個圖片文件');
        return;
      }

      uploadCoverBtn.disabled = true;
      uploadStatus.style.display = 'block';
      uploadStatus.textContent = '正在上傳...';
      uploadStatus.style.color = '#666';

      try {
        const formData = new FormData();
        formData.append('image', file);

        const result = await apiRequest('/api/admin/upload-image', {
          method: 'POST',
          body: formData,
        });

        // Auto-fill the URL
        coverUrlInput.value = result.url;
        uploadStatus.textContent = '✅ 上傳成功！URL 已自動填充';
        uploadStatus.style.color = '#28a745';
      } catch (err) {
        let msg = err.message;
        if (msg.includes('EROFS') || msg.includes('read-only')) {
          msg = 'Vercel 服務器文件系統只讀，無法保存文件。\n請將圖片上傳到免費圖床（Imgur、Discord 等），然後手動粘帖 URL 到上方輸入框。';
        }
        uploadStatus.textContent = '❌ 上傳失敗: ' + msg;
        uploadStatus.style.color = '#dc3545';
      } finally {
        uploadCoverBtn.disabled = false;
      }
    });
  }

  basicForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const data = {
      title: document.getElementById('title').value.trim(),
      description: document.getElementById('description').value.trim(),
      total_boxes: document.getElementById('total_boxes').value,
      price_per_box: document.getElementById('price_per_box').value,
      num_pools: document.getElementById('num_pools').value || 1,
    };

    if (!data.title || !data.total_boxes || !data.price_per_box) {
      alert('請填寫所有必填欄位');
      return;
    }

    try {
      const formData = new FormData();
      Object.entries(data).forEach(([k, v]) => formData.append(k, v));
      const result = await apiRequest('/api/admin/raffles/create', {
        method: 'POST',
        body: formData,
      });

      currentRaffleId = result.raffleId;

      // Go to step 2
      document.getElementById('step1').classList.remove('active');
      document.getElementById('step2').classList.add('active');

      // Update pool number max based on num_pools
      const numPools = parseInt(data.num_pools);
      document.getElementById('pool_number').max = numPools;

    } catch (err) {
      alert(err.message);
    }
  });

  // Show/hide pool number for final prize
  if (isFinalCheckbox) {
    isFinalCheckbox.addEventListener('change', () => {
      poolNumberGroup.style.display = isFinalCheckbox.checked ? 'block' : 'none';
    });
  }

  // Add item button
  document.getElementById('addItemBtn').addEventListener('click', addItem);

  // Load default template button
  document.getElementById('loadDefaultTemplateBtn').addEventListener('click', () => {
    if (!currentRaffleId) {
      alert('請先建立服務基本資訊');
      return;
    }
    if (itemsAdded.length > 0) {
      if (!confirm('已經有商品，確定要載入預設 template 嗎？會新增多個商品')) {
        return;
      }
    }

    // Default Ichiban Kuji item template (total 80: corrected by user)
    const defaultItems = [
      { tier: 'A', name: 'OFF會參加券', description: '', total_count: 1, is_final: false },
      { tier: 'B', name: '見面會 - 10秒個人攝影券', description: '', total_count: 3, is_final: false },
      { tier: 'C', name: '見面會 - 10秒自拍券', description: '', total_count: 4, is_final: false },
      { tier: 'D', name: '見面會 - 15秒video券', description: '', total_count: 6, is_final: false },
      { tier: 'E', name: '見面會 - 簽名券', description: '', total_count: 8, is_final: false },
      { tier: 'F', name: '見面會 - 合照券', description: '', total_count: 18, is_final: false },
      { tier: 'G', name: '簽名拍立得', description: '', total_count: 39, is_final: false },
      { tier: 'LAST', name: '迪士尼入場券', description: '', total_count: 1, is_final: true, pool_number: 1 }
    ];

    // Add all items one by one
    async function addAll() {
      const btn = document.getElementById('loadDefaultTemplateBtn');
      btn.disabled = true;
      btn.textContent = `載入中... 0/${defaultItems.length}`;

      try {
        for (let i = 0; i < defaultItems.length; i++) {
          const p = defaultItems[i];
          const result = await apiRequest(`/api/admin/raffles/${currentRaffleId}/items/add`, {
            method: 'POST',
            body: JSON.stringify(p)
          });
          itemsAdded.push({ ...p, id: result.itemId });
          btn.textContent = `載入中... ${i + 1}/${defaultItems.length}`;
        }

        renderItemList();
        if (itemsAdded.length > 0) {
          document.getElementById('finishBtn').disabled = false;
        }
        alert(`預設 template 載入完成！已新增 ${defaultItems.length} 個商品`);
      } catch (err) {
        alert(`載入失敗: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = '載入預設一番賞商品 template';
      }
    }

    addAll();
  });

  // Back button
  document.getElementById('backToStep1').addEventListener('click', () => {
    if (itemsAdded.length > 0) {
      if (!confirm('離開後已新增的商品會保留，確定要回去嗎?')) {
        return;
      }
    }
    document.getElementById('step2').classList.remove('active');
    document.getElementById('step1').classList.add('active');
  });

  // Finish button
  document.getElementById('finishBtn').addEventListener('click', () => {
    window.location.href = '/admin';
  });
}

async function addItem() {
  if (!currentRaffleId) {
    alert('請先建立服務基本資訊');
    return;
  }

  const tier = document.getElementById('tier').value;
  const name = document.getElementById('item_name').value.trim();
  const description = document.getElementById('item_description').value.trim();
  const image_url = document.getElementById('image_url').value.trim();
  const total_count = document.getElementById('total_count').value;
  const is_final = document.getElementById('is_final').checked;
  const pool_number = document.getElementById('pool_number').value || 1;

  if (!name || !total_count) {
    alert('請填寫商品名稱和數量');
    return;
  }

  try {
    const payload = {
      tier,
      name,
      description,
      image_url,
      total_count: parseInt(total_count, 10),
      is_final,
      pool_number: is_final ? parseInt(pool_number, 10) : null
    };

    if (editingItemId) {
      await apiRequest(`/api/admin/raffles/${currentRaffleId}/items/${editingItemId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      itemsAdded = itemsAdded.map(p =>
        p.id === editingItemId ? { ...p, ...payload, total_count: payload.total_count } : p
      );
      editingItemId = null;
      document.getElementById('addItemBtn').textContent = '新增此商品';
    } else {
      const result = await apiRequest(`/api/admin/raffles/${currentRaffleId}/items/add`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      itemsAdded.push({
        id: result.itemId,
        ...payload
      });
    }

    // Refresh display
    renderItemList();

    // Clear form
    document.getElementById('item_name').value = '';
    document.getElementById('item_description').value = '';
    document.getElementById('image_url').value = '';
    document.getElementById('total_count').value = '1';
    document.getElementById('is_final').checked = false;
    document.getElementById('poolNumberGroup').style.display = 'none';

    // Enable finish button
    if (itemsAdded.length > 0) {
      document.getElementById('finishBtn').disabled = false;
    }

  } catch (err) {
    alert(err.message);
  }
}

function renderItemList() {
  const listEl = document.getElementById('itemList');
  const countEl = document.getElementById('itemCount');

  countEl.textContent = itemsAdded.length;

  if (itemsAdded.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>尚無商品，請在右側新增</p></div>`;
    return;
  }

  let html = '';
  itemsAdded.forEach((item) => {
    html += `
      <div class="item-admin-card ${item.is_final ? 'final' : ''}">
        <div class="item-admin-info">
          <h4>${escapeHtml(item.tier)} - ${escapeHtml(item.name)}</h4>
          <p>數量: ${item.total_count} ${item.is_final ? '(最終賞)' : ''}</p>
        </div>
        <div class="item-admin-actions">
          <div class="item-admin-qty">
            <button class="btn btn-sm btn-secondary" data-action="dec" data-id="${item.id}">-</button>
            <span class="item-admin-qty-text">${item.total_count}</span>
            <button class="btn btn-sm btn-secondary" data-action="inc" data-id="${item.id}">+</button>
          </div>
          <button class="btn btn-sm btn-primary" data-action="edit" data-id="${item.id}">編輯</button>
          <button class="btn btn-sm btn-warning" data-action="delete" data-id="${item.id}">刪除</button>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id, 10);
      const action = btn.dataset.action;
      const item = itemsAdded.find(p => p.id === id);
      if (!item) return;

      if (action === 'edit') {
        editingItemId = id;
        document.getElementById('tier').value = item.tier;
        document.getElementById('item_name').value = item.name || '';
        document.getElementById('item_description').value = item.description || '';
        document.getElementById('image_url').value = item.image_url || '';
        document.getElementById('total_count').value = String(item.total_count || 1);
        document.getElementById('is_final').checked = !!item.is_final;
        document.getElementById('poolNumberGroup').style.display = item.is_final ? 'block' : 'none';
        if (item.is_final) {
          document.getElementById('pool_number').value = String(item.pool_number || 1);
        }
        document.getElementById('addItemBtn').textContent = '更新商品';
        return;
      }

      if (action === 'delete') {
        if (!confirm('確定要刪除此商品嗎?')) return;
        try {
          await apiRequest(`/api/admin/raffles/${currentRaffleId}/items/${item.id}`, { method: 'DELETE' });
          itemsAdded = itemsAdded.filter(p => p.id !== id);
          if (editingItemId === id) {
            editingItemId = null;
            document.getElementById('addItemBtn').textContent = '新增此商品';
          }
          renderItemList();
          if (itemsAdded.length === 0) {
            document.getElementById('finishBtn').disabled = true;
          }
        } catch (err) {
          alert(err.message);
        }
        return;
      }

      if (action === 'inc' || action === 'dec') {
        const delta = action === 'inc' ? 1 : -1;
        const nextTotal = parseInt(item.total_count, 10) + delta;
        if (!nextTotal || nextTotal < 1) return;
        btn.disabled = true;
        try {
          await apiRequest(`/api/admin/raffles/${currentRaffleId}/items/${item.id}`, {
            method: 'PUT',
            body: JSON.stringify({
              tier: item.tier,
              name: item.name,
              description: item.description,
              image_url: item.image_url,
              total_count: nextTotal,
              is_final: !!item.is_final,
              pool_number: item.is_final ? item.pool_number || 1 : null
            })
          });
          itemsAdded = itemsAdded.map(p => (p.id === id ? { ...p, total_count: nextTotal } : p));
          renderItemList();
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
        }
      }
    });
  });
}

function initAdminUsersPage() {
  const tbody = document.getElementById('usersTbody');
  const searchInput = document.getElementById('userSearch');
  const searchBtn = document.getElementById('searchBtn');

  if (!tbody || !searchInput || !searchBtn) return;

  async function loadUsers() {
    const q = searchInput.value.trim();
    const url = q ? `/api/admin/users?q=${encodeURIComponent(q)}` : '/api/admin/users';
    const result = await apiRequest(url);
    const users = result.users || [];

    if (users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding:16px;">沒有結果</td></tr>';
      return;
    }

    let html = '';
    users.forEach(u => {
      html += `
        <tr>
          <td>${u.id}</td>
          <td>${escapeHtml(u.username || '')}${u.is_admin ? ' (admin)' : ''}</td>
          <td>${escapeHtml(u.contact || '-')}</td>
          <td>${u.entries_count || 0}</td>
          <td>${u.codes_assigned_count || 0}</td>
          <td>${u.codes_used_count || 0}</td>
          <td>${u.created_at ? new Date(u.created_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : ''}</td>
          <td class="actions">
            <button class="btn btn-sm btn-warning" data-action="reset" data-id="${u.id}" data-username="${escapeHtml(u.username || '')}">重置密碼</button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

    tbody.querySelectorAll('button[data-action="reset"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const username = btn.dataset.username;
        const password = prompt(`重置會員 ${username} 新密碼（至少 6 個字）`);
        if (!password) return;
        btn.disabled = true;
        try {
          await apiRequest(`/api/admin/users/${id}/reset-password`, {
            method: 'POST',
            body: JSON.stringify({ password })
          });
          alert('已重置密碼');
        } catch (err) {
          alert(err.message);
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  searchBtn.addEventListener('click', () => {
    loadUsers().catch(err => alert(err.message));
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      loadUsers().catch(err => alert(err.message));
    }
  });

  loadUsers().catch(err => alert(err.message));
}

// ============================================
// Edit Raffle Page
// ==========================================
function initEditPage() {
  const basicForm = document.getElementById('basicInfoForm');
  const coverFileInput = document.getElementById('cover_image_file');
  const coverUrlInput = document.getElementById('cover_image_url');
  const coverPreview = document.getElementById('coverPreview');
  const coverPreviewImg = document.getElementById('coverPreviewImg');
  const uploadCoverBtn = document.getElementById('uploadCoverBtn');
  const uploadStatus = document.getElementById('uploadStatus');

  if (coverFileInput && coverPreview && coverPreviewImg) {
    coverFileInput.addEventListener('change', () => {
      const file = coverFileInput.files && coverFileInput.files[0];
      if (!file) {
        coverPreview.style.display = 'none';
        coverPreviewImg.removeAttribute('src');
        return;
      }
      coverPreview.style.display = 'block';
      coverPreviewImg.src = URL.createObjectURL(file);
    });
  }

  // Upload cover image to server
  if (uploadCoverBtn) {
    uploadCoverBtn.addEventListener('click', async () => {
      const file = coverFileInput.files && coverFileInput.files[0];
      if (!file) {
        alert('請先選擇一個圖片文件');
        return;
      }

      uploadCoverBtn.disabled = true;
      uploadStatus.style.display = 'block';
      uploadStatus.textContent = '正在上傳...';
      uploadStatus.style.color = '#666';

      try {
        const formData = new FormData();
        formData.append('image', file);

        const result = await apiRequest('/api/admin/upload-image', {
          method: 'POST',
          body: formData,
        });

        // Auto-fill the URL
        coverUrlInput.value = result.url;
        uploadStatus.textContent = '✅ 上傳成功！URL 已自動填充';
        uploadStatus.style.color = '#28a745';
      } catch (err) {
        let msg = err.message;
        if (msg.includes('EROFS') || msg.includes('read-only')) {
          msg = 'Vercel 服務器文件系統只讀，無法保存文件。\n請將圖片上傳到免費圖床（Imgur、Discord 等），然後手動粘帖 URL 到上方輸入框。';
        }
        uploadStatus.textContent = '❌ 上傳失敗: ' + msg;
        uploadStatus.style.color = '#dc3545';
      } finally {
        uploadCoverBtn.disabled = false;
      }
    });
  }

  // Handle form submit
  if (basicForm) {
    basicForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const data = {
        title: document.getElementById('title').value.trim(),
        description: document.getElementById('description').value,
        total_boxes: document.getElementById('total_boxes').value,
        price_per_box: document.getElementById('price_per_box').value,
        cover_image: document.getElementById('cover_image_url').value || null,
        status: document.getElementById('status').value
      };

      try {
        // Get raffle ID from the page (injected by EJS)
        const raffleId = window.raffleId;
        await apiRequest(`/api/admin/raffles/${raffleId}/update`, {
          method: 'PUT',
          body: JSON.stringify(data),
        });

        alert('✅ 保存成功！');
        window.location.href = '/admin';
      } catch (err) {
        alert('❌ 保存失敗: ' + err.message);
      }
    });
  }
}

// ============================================
// Export for inline script calls
// ============================================
window.initRafflePage = initRafflePage;
window.initAdminDashboard = initAdminDashboard;
window.initCreateRafflePage = initCreateRafflePage;
window.initAdminUsersPage = initAdminUsersPage;
window.initEditPage = initEditPage;
