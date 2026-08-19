(function () {
'use strict';

const MOCAP_MODES = [
  { id: 'face', label: 'Face', cmd: 'Face' },
  { id: 'body', label: 'Body', cmd: 'Body' },
  { id: 'body-hands', label: 'Body + Hands', cmd: 'Body+Hands' },
  { id: 'face-body', label: 'Face + Body', cmd: 'Face+Body' },
  { id: 'full', label: 'Full Body', cmd: 'Full Body' },
  { id: 'full-holistic', label: 'Full (Legacy)', cmd: 'Full Body Holistic' },
];

const EXPORT_FORMATS = [
  { id: 'fbx', label: 'FBX (Mixamo)', hint: 'For khavee-sdk', badge: 'Recommended' },
  { id: 'vrma', label: 'VRMA', hint: 'VRM Animation' },
  { id: 'bvh', label: 'BVH', hint: 'Universal skeleton' },
  { id: 'gltf', label: 'glTF', hint: 'Scene + animation' },
  { id: 'vmd', label: 'VMD', hint: 'MikuMikuDance' },
];

let state = {
  mocapMode: null,
  recording: false,
  recordSpeed: 1,
  activePanel: null,
};

function isEngineReady() {
  return typeof MMD_SA !== 'undefined' && MMD_SA.initialized &&
    MMD_SA.THREEX && MMD_SA.THREEX.utils &&
    typeof System !== 'undefined' && System._browser && System._browser.camera;
}

function waitForEngine(cb) {
  if (isEngineReady()) { cb(); return; }
  const t = setInterval(() => {
    if (isEngineReady()) { clearInterval(t); cb(); }
  }, 200);
}

function showStatus(msg, duration) {
  const el = document.getElementById('xra-status');
  el.querySelector('.xra-status-text').textContent = msg;
  el.classList.add('visible');
  if (duration) setTimeout(() => el.classList.remove('visible'), duration);
}

// ====== MOCAP ======
function startMocap(mode) {
  if (!isEngineReady()) return;
  state.mocapMode = mode.id;
  System._browser.camera.streamer_mode.init_mocap(mode.cmd);
  showStatus('Mocap: ' + mode.label, 3000);
  renderMocapPanel();
}

function stopMocap() {
  if (!isEngineReady()) return;
  state.mocapMode = null;
  if (typeof MMD_SA.WebXR !== 'undefined') {
    MMD_SA.WebXR.user_camera.facemesh.enabled = false;
    MMD_SA.WebXR.user_camera.poseNet.enabled = false;
    if (MMD_SA.WebXR.user_camera.handpose)
      MMD_SA.WebXR.user_camera.handpose.enabled = false;
  }
  showStatus('Mocap stopped', 2000);
  renderMocapPanel();
}

function startRecording() {
  if (!isEngineReady()) return;
  state.recording = true;
  System._browser.camera.motion_recorder.speed = state.recordSpeed;
  showStatus('Recording started (x' + state.recordSpeed + ')', 3000);
  renderMocapPanel();
}

function stopRecording() {
  state.recording = false;
  showStatus('Recording stopped', 2000);
  renderMocapPanel();
}

// ====== EXPORT ======
async function doExport(format) {
  if (!isEngineReady()) return;

  const vmd = System._browser.camera.motion_recorder.vmd;
  const hasMotion = vmd || (MMD_SA.vmd_by_filename &&
    MMD_SA.vmd_by_filename[MMD_SA.MMD.motionManager.filename] &&
    /\.(bvh|fbx|glb|vrma)$/i.test(MMD_SA.vmd_by_filename[MMD_SA.MMD.motionManager.filename].url));

  if (!vmd && !hasMotion) {
    showStatus('No motion recorded or loaded', 3000);
    return;
  }

  showStatus('Exporting ' + format.label + '...', 0);
  setBtnState(format.id, 'saving');

  try {
    switch (format.id) {
      case 'fbx':
        await MMD_SA.THREEX.utils.export_FBX_mixamo();
        break;
      case 'vrma':
        await MMD_SA.THREEX.utils.export_VRMA();
        break;
      case 'bvh': {
        const v = vmd || MMD_SA.vmd_by_filename[MMD_SA.MMD.motionManager.filename];
        const fname = vmd ? 'motion_' + Date.now() + '.bvh' : MMD_SA.MMD.motionManager.filename + '.bvh';
        await System._browser.load_script(toFileProtocol(System.Gadget.path + '/export/BVH_filewriter.js'));
        BVH_FileWriter(fname, v.boneKeys);
        break;
      }
      case 'gltf': {
        const v = vmd || MMD_SA.vmd_by_filename[MMD_SA.MMD.motionManager.filename];
        const fname = vmd ? 'motion_' + Date.now() + '.glb' : MMD_SA.MMD.motionManager.filename + '.glb';
        await MMD_SA.THREEX.utils.export_GLTF_motion(fname, v);
        break;
      }
      case 'vmd': {
        const v = vmd || MMD_SA.vmd_by_filename[MMD_SA.MMD.motionManager.filename];
        const fname = vmd ? 'motion_' + Date.now() + '.vmd' : MMD_SA.MMD.motionManager.filename + '.vmd';
        await MMD_SA.VMD_FileWriter();
        VMD_FileWriter(fname, v.boneKeys, v.morphKeys);
        break;
      }
    }
    setBtnState(format.id, 'done');
    showStatus(format.label + ' saved', 3000);
  } catch (e) {
    console.error('[XRA Export]', e);
    setBtnState(format.id, '');
    showStatus('Export failed', 3000);
  }
}

function setBtnState(id, cls) {
  const btn = document.querySelector(`[data-export="${id}"]`);
  if (!btn) return;
  btn.classList.remove('saving', 'done');
  if (cls) btn.classList.add(cls);
  const badge = btn.querySelector('.badge');
  if (cls === 'saving') badge.textContent = 'Saving...';
  else if (cls === 'done') badge.textContent = 'Done';
  else badge.textContent = EXPORT_FORMATS.find(f => f.id === id)?.badge || '';
}

// ====== LOAD ======
function setupDragDrop() {
  const zone = document.getElementById('xra-drop-zone');
  if (!zone) return;

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length && isEngineReady()) {
      SA_DragDropEMU(e.dataTransfer.files[0]);
      togglePanel(null);
      showStatus('Loading file...', 3000);
    }
  });

  const fileInput = document.getElementById('xra-file-input');
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length && isEngineReady()) {
      SA_DragDropEMU(fileInput.files[0]);
      togglePanel(null);
      showStatus('Loading file...', 3000);
    }
  });
}

// ====== PANEL TOGGLE ======
function togglePanel(name) {
  state.activePanel = (state.activePanel === name) ? null : name;
  document.querySelectorAll('.xra-panel').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.xra-topbar button').forEach(b => b.classList.remove('active'));
  if (state.activePanel) {
    const panel = document.getElementById('xra-' + state.activePanel + '-panel');
    if (panel) panel.classList.add('open');
    const btn = document.querySelector(`[data-panel="${state.activePanel}"]`);
    if (btn) btn.classList.add('active');
  }
}

// ====== RENDER ======
function renderMocapPanel() {
  const modes = document.getElementById('xra-mocap-modes');
  if (!modes) return;
  modes.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.mode === state.mocapMode);
  });
  const recordBtn = document.getElementById('xra-record-btn');
  if (recordBtn) {
    recordBtn.classList.toggle('recording', state.recording);
    recordBtn.querySelector('span').textContent = state.recording ? 'Stop Recording' : 'Record';
  }
}

function render() {
  const root = document.getElementById('xra-ui');
  root.innerHTML = `
    <div class="xra-topbar">
      <button data-panel="mocap" onclick="XRA.togglePanel('mocap')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-7 8-7s8 3 8 7"/></svg>
        <span>Mocap</span>
      </button>
      <button data-panel="load" onclick="XRA.togglePanel('load')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
        <span>Load</span>
      </button>
      <button data-panel="export" onclick="XRA.togglePanel('export')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21V9m0 0l-4 4m4-4l4 4"/><path d="M4 3h16"/></svg>
        <span>Export</span>
      </button>
    </div>

    <div id="xra-mocap-panel" class="xra-panel">
      <div class="xra-panel-title">Motion Capture</div>
      <div class="xra-mocap-modes" id="xra-mocap-modes">
        ${MOCAP_MODES.map(m => `<button data-mode="${m.id}" onclick="XRA.startMocap('${m.id}')">${m.label}</button>`).join('')}
      </div>
      <div style="margin-bottom:8px;">
        <button onclick="XRA.stopMocap()" style="width:100%;padding:8px;border-radius:var(--radius-sm);border:1px solid var(--border);font-size:12px;color:var(--text-muted);">Stop Tracking</button>
      </div>
      <div class="xra-record-section">
        <button id="xra-record-btn" class="xra-record-btn" onclick="XRA.toggleRecord()">
          <div class="xra-record-dot"></div>
          <span>Record</span>
        </button>
        <select class="xra-speed-select" onchange="XRA.setSpeed(this.value)">
          <option value="1">x1</option>
          <option value="0.5">x0.5</option>
          <option value="0.25">x0.25</option>
        </select>
      </div>
    </div>

    <div id="xra-load-panel" class="xra-panel">
      <div class="xra-panel-title">Load Model / Motion</div>
      <div id="xra-drop-zone" class="xra-drop-zone">
        <p>Drop a file here</p>
        <div class="or">or</div>
        <button class="xra-file-btn" onclick="document.getElementById('xra-file-input').click()">Browse Files</button>
        <input type="file" id="xra-file-input" style="display:none" accept=".vrm,.pmx,.glb,.fbx,.bvh,.vmd,.vrma,.zip,.png,.jpg,.webp,.mp4,.webm">
      </div>
      <p style="font-size:11px;color:var(--text-muted)">Supports: VRM, PMX, glTF, FBX, BVH, VMD, VRMA, images, videos</p>
    </div>

    <div id="xra-export-panel" class="xra-panel">
      <div class="xra-panel-title">Export Motion</div>
      <div class="xra-export-list">
        ${EXPORT_FORMATS.map(f => `
          <button class="xra-export-btn" data-export="${f.id}" onclick="XRA.doExport('${f.id}')">
            <div>
              <div class="label">${f.label}</div>
              <div class="hint">${f.hint}</div>
            </div>
            ${f.badge ? `<div class="badge">${f.badge}</div>` : '<div class="badge"></div>'}
          </button>
        `).join('')}
      </div>
    </div>

    <div id="xra-status" class="xra-status">
      <div class="xra-status-dot"></div>
      <span class="xra-status-text"></span>
    </div>
  `;

  renderMocapPanel();
  setupDragDrop();
}

// ====== PUBLIC API ======
window.XRA = {
  togglePanel,
  startMocap: (id) => startMocap(MOCAP_MODES.find(m => m.id === id)),
  stopMocap,
  toggleRecord: () => state.recording ? stopRecording() : startRecording(),
  setSpeed: (v) => { state.recordSpeed = parseFloat(v); },
  doExport: (id) => doExport(EXPORT_FORMATS.find(f => f.id === id)),
};

// ====== INIT ======
function init() {
  const root = document.createElement('div');
  root.id = 'xra-ui';
  document.body.appendChild(root);

  // Hide legacy UI
  const legacyMenu = document.getElementById('Lquick_menu');
  if (legacyMenu) legacyMenu.style.display = 'none';
  const legacyNumpad = document.getElementById('Lnumpad');
  if (legacyNumpad) legacyNumpad.style.display = 'none';

  render();
}

waitForEngine(init);
})();
