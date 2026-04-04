// ============================================
// Ichiban Kuji Raffle - Frontend JavaScript
// ============================================

// Global variables for raffle page
let currentRaffleId = null;

// Utility functions
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
      drawBtn.textContent = '抽獎中...';

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
          <div class="result-prize ${result.prize.is_final ? 'final-result' : ''}">
            ${result.prize.is_final ? '🎉 恭喜中得最終賞! 🎉<br>' : ''}
            ${result.prize.name}
          </div>
          <p>抽獎完成，請保留截圖並聯絡商家領獎</p>
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
        drawBtn.textContent = '開始抽獎!';
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
      if (!confirm(`確定要${action}此抽獎活動嗎?`)) {
        return;
      }

      try {
        await apiRequest(`/api/admin/raffles/${raffleId}/status`, {
          method: 'POST',
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
      if (!confirm('確定要重置抽獎活動列表嗎？此操作會刪除所有抽獎、獎品、驗證碼及抽獎記錄。')) {
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
            <td><code class="code-text">${code.code}</code></td>
            <td><span class="status-badge ${statusClass}">${status}</span></td>
            <td>${new Date(code.created_at).toLocaleString('zh-HK')}</td>
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
let prizesAdded = [];
let editingPrizeId = null;

function initCreateRafflePage() {
  // Step 1: Basic info
  const basicForm = document.getElementById('basicInfoForm');
  const isFinalCheckbox = document.getElementById('is_final');
  const poolNumberGroup = document.getElementById('poolNumberGroup');
  const coverInput = document.getElementById('cover_image');
  const coverPreview = document.getElementById('coverPreview');
  const coverPreviewImg = document.getElementById('coverPreviewImg');

  if (coverInput && coverPreview && coverPreviewImg) {
    coverInput.addEventListener('change', () => {
      const file = coverInput.files && coverInput.files[0];
      if (!file) {
        coverPreview.style.display = 'none';
        coverPreviewImg.removeAttribute('src');
        return;
      }
      coverPreview.style.display = 'block';
      coverPreviewImg.src = URL.createObjectURL(file);
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
      const coverFile = coverInput && coverInput.files && coverInput.files[0];
      if (coverFile) {
        formData.append('cover_image', coverFile);
      }
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

  // Add prize button
  document.getElementById('addPrizeBtn').addEventListener('click', addPrize);

  // Back button
  document.getElementById('backToStep1').addEventListener('click', () => {
    if (prizesAdded.length > 0) {
      if (!confirm('離開後已新增的獎品會保留，確定要回去嗎?')) {
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

async function addPrize() {
  if (!currentRaffleId) {
    alert('請先建立抽獎基本資訊');
    return;
  }

  const tier = document.getElementById('tier').value;
  const name = document.getElementById('prize_name').value.trim();
  const description = document.getElementById('prize_description').value.trim();
  const image_url = document.getElementById('image_url').value.trim();
  const total_count = document.getElementById('total_count').value;
  const is_final = document.getElementById('is_final').checked;
  const pool_number = document.getElementById('pool_number').value || 1;

  if (!name || !total_count) {
    alert('請填寫獎品名稱和數量');
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

    if (editingPrizeId) {
      await apiRequest(`/api/admin/raffles/${currentRaffleId}/prizes/${editingPrizeId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      prizesAdded = prizesAdded.map(p =>
        p.id === editingPrizeId ? { ...p, ...payload, total_count: payload.total_count } : p
      );
      editingPrizeId = null;
      document.getElementById('addPrizeBtn').textContent = '新增此獎品';
    } else {
      const result = await apiRequest(`/api/admin/raffles/${currentRaffleId}/prizes/add`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      prizesAdded.push({
        id: result.prizeId,
        ...payload
      });
    }

    // Refresh display
    renderPrizeList();

    // Clear form
    document.getElementById('prize_name').value = '';
    document.getElementById('prize_description').value = '';
    document.getElementById('image_url').value = '';
    document.getElementById('total_count').value = '1';
    document.getElementById('is_final').checked = false;
    document.getElementById('poolNumberGroup').style.display = 'none';

    // Enable finish button
    if (prizesAdded.length > 0) {
      document.getElementById('finishBtn').disabled = false;
    }

  } catch (err) {
    alert(err.message);
  }
}

function renderPrizeList() {
  const listEl = document.getElementById('prizeList');
  const countEl = document.getElementById('prizeCount');

  countEl.textContent = prizesAdded.length;

  if (prizesAdded.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><p>尚無獎品，請在右側新增</p></div>`;
    return;
  }

  let html = '';
  prizesAdded.forEach((prize) => {
    html += `
      <div class="prize-admin-card ${prize.is_final ? 'final' : ''}">
        <div class="prize-admin-info">
          <h4>${prize.tier} - ${prize.name}</h4>
          <p>數量: ${prize.total_count} ${prize.is_final ? '(最終賞)' : ''}</p>
        </div>
        <div class="prize-admin-actions">
          <div class="prize-admin-qty">
            <button class="btn btn-sm btn-secondary" data-action="dec" data-id="${prize.id}">-</button>
            <span class="prize-admin-qty-text">${prize.total_count}</span>
            <button class="btn btn-sm btn-secondary" data-action="inc" data-id="${prize.id}">+</button>
          </div>
          <button class="btn btn-sm btn-primary" data-action="edit" data-id="${prize.id}">編輯</button>
          <button class="btn btn-sm btn-warning" data-action="delete" data-id="${prize.id}">刪除</button>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;

  listEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id, 10);
      const action = btn.dataset.action;
      const prize = prizesAdded.find(p => p.id === id);
      if (!prize) return;

      if (action === 'edit') {
        editingPrizeId = id;
        document.getElementById('tier').value = prize.tier;
        document.getElementById('prize_name').value = prize.name || '';
        document.getElementById('prize_description').value = prize.description || '';
        document.getElementById('image_url').value = prize.image_url || '';
        document.getElementById('total_count').value = String(prize.total_count || 1);
        document.getElementById('is_final').checked = !!prize.is_final;
        document.getElementById('poolNumberGroup').style.display = prize.is_final ? 'block' : 'none';
        if (prize.is_final) {
          document.getElementById('pool_number').value = String(prize.pool_number || 1);
        }
        document.getElementById('addPrizeBtn').textContent = '更新獎品';
        return;
      }

      if (action === 'delete') {
        if (!confirm('確定要刪除此獎品嗎?')) return;
        try {
          await apiRequest(`/api/admin/raffles/${currentRaffleId}/prizes/${id}`, { method: 'DELETE' });
          prizesAdded = prizesAdded.filter(p => p.id !== id);
          if (editingPrizeId === id) {
            editingPrizeId = null;
            document.getElementById('addPrizeBtn').textContent = '新增此獎品';
          }
          renderPrizeList();
          if (prizesAdded.length === 0) {
            document.getElementById('finishBtn').disabled = true;
          }
        } catch (err) {
          alert(err.message);
        }
        return;
      }

      if (action === 'inc' || action === 'dec') {
        const delta = action === 'inc' ? 1 : -1;
        const nextTotal = parseInt(prize.total_count, 10) + delta;
        if (!nextTotal || nextTotal < 1) return;
        btn.disabled = true;
        try {
          await apiRequest(`/api/admin/raffles/${currentRaffleId}/prizes/${id}`, {
            method: 'PUT',
            body: JSON.stringify({
              tier: prize.tier,
              name: prize.name,
              description: prize.description,
              image_url: prize.image_url,
              total_count: nextTotal,
              is_final: !!prize.is_final,
              pool_number: prize.is_final ? prize.pool_number || 1 : null
            })
          });
          prizesAdded = prizesAdded.map(p => (p.id === id ? { ...p, total_count: nextTotal } : p));
          renderPrizeList();
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
          <td>${u.username || ''}${u.is_admin ? ' (admin)' : ''}</td>
          <td>${u.contact || '-'}</td>
          <td>${u.entries_count || 0}</td>
          <td>${u.codes_assigned_count || 0}</td>
          <td>${u.codes_used_count || 0}</td>
          <td>${u.created_at ? new Date(u.created_at).toLocaleString('zh-HK') : ''}</td>
          <td class="actions">
            <button class="btn btn-sm btn-warning" data-action="reset" data-id="${u.id}" data-username="${u.username || ''}">重置密碼</button>
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
// Export for inline script calls
// ============================================
window.initRafflePage = initRafflePage;
window.initAdminDashboard = initAdminDashboard;
window.initCreateRafflePage = initCreateRafflePage;
window.initAdminUsersPage = initAdminUsersPage;
