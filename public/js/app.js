// ============================================
// Ichiban Kuji Raffle - Frontend JavaScript
// ============================================

// Global variables for raffle page
let currentRaffleId = null;

// Utility functions
async function apiRequest(url, options = {}) {
  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
    },
  };

  const response = await fetch(url, { ...defaultOptions, ...options });
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

      const name = document.getElementById('name').value.trim();
      const contact = document.getElementById('contact').value.trim();
      const drawBtn = document.getElementById('drawBtn');

      if (!name || !contact) {
        alert('請填寫姓名和聯絡方式');
        return;
      }

      drawBtn.disabled = true;
      drawBtn.textContent = '抽獎中...';

      try {
        const result = await apiRequest(`/api/raffle/${currentRaffleId}/draw`, {
          method: 'POST',
          body: JSON.stringify({ name, contact }),
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
}

// ============================================
// Create Raffle Page (Wizard)
// ============================================
let prizesAdded = [];

function initCreateRafflePage() {
  // Step 1: Basic info
  const basicForm = document.getElementById('basicInfoForm');
  const isFinalCheckbox = document.getElementById('is_final');
  const poolNumberGroup = document.getElementById('poolNumberGroup');

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
      const result = await apiRequest('/api/admin/raffles/create', {
        method: 'POST',
        body: JSON.stringify(data),
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
    const result = await apiRequest(`/api/admin/raffles/${currentRaffleId}/prizes/add`, {
      method: 'POST',
      body: JSON.stringify({
        tier,
        name,
        description,
        image_url,
        total_count: parseInt(total_count),
        is_final,
        pool_number: is_final ? parseInt(pool_number) : null,
      }),
    });

    // Add to list
    prizesAdded.push({
      id: result.prizeId,
      tier,
      name,
      total_count,
      is_final,
    });

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
  prizesAdded.forEach((prize, index) => {
    html += `
      <div class="prize-admin-card ${prize.is_final ? 'final' : ''}">
        <div class="prize-admin-info">
          <h4>${prize.tier} - ${prize.name}</h4>
          <p>數量: ${prize.total_count} ${prize.is_final ? '(最終賞)' : ''}</p>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = html;
}

// ============================================
// Export for inline script calls
// ============================================
window.initRafflePage = initRafflePage;
window.initAdminDashboard = initAdminDashboard;
window.initCreateRafflePage = initCreateRafflePage;
