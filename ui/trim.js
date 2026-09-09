// Motion trim overlay - lets the user pick a start/end time range on a
// recorded mocap clip before export.
(function () {
'use strict';

let root, timelineEl, startHandle, endHandle, rangeEl, playheadEl;
let clipDuration = 0;
let trimStart = 0, trimEnd = 0;
let dragging = null;

let lastVmdRef = null;
let savedDetectorState = null;
let isPlaying = false;
let playheadRAF = null;

window.XRA_trimmedVMD = null;

function isEngineReady() {
  return typeof MMD_SA !== 'undefined' && MMD_SA.initialized &&
    typeof System !== 'undefined' && System._browser && System._browser.camera;
}

function boneKeysDuration(vmd) {
  let max = 0;
  (vmd.boneKeys || []).forEach(k => { if (k.time > max) max = k.time; });
  (vmd.morphKeys || []).forEach(k => { if (k.time > max) max = k.time; });
  return max;
}

// --- Animation clip builder ---
// Builds a THREE.AnimationClip from recorded boneKeys using the same logic
// as the engine's export_GLTF_motion (MMD_SA.js:13864). Tracks target the
// model's normalized bone nodes so the native mixer/animation system works.
function buildClipFromVMD(vmd) {
  const THREEX_THREE = MMD_SA.THREEX.THREE;
  const model = MMD_SA.THREEX.get_model(0);
  const VRM = MMD_SA.THREEX.VRM;
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  const q1 = new THREE.Quaternion();
  const q2 = new THREE.Quaternion();

  let time_max = 0;
  const boneKeys_by_name = {};
  vmd.boneKeys.forEach(k => {
    if (!boneKeys_by_name[k.name])
      boneKeys_by_name[k.name] = { keys: [], keys_full: [] };
    boneKeys_by_name[k.name].keys.push(k);
    time_max = Math.max(time_max, k.time);
  });

  const f_max = Math.round(time_max * 30) + 1;

  // Interpolate keys for bones that need frame-sync
  const name_sync = ['全ての親', 'センター', '上半身', '下半身'];
  for (const d of ['左', '右']) {
    if (boneKeys_by_name[d + '手捩']) {
      if (boneKeys_by_name[d + 'ひじ'] && ((boneKeys_by_name[d + '手捩'].keys.length > 2) || boneKeys_by_name[d + '手捩'].keys.some(k => k.rot[3] != 1))) {
        name_sync.push(d + 'ひじ', d + '手捩');
      }
    }
  }

  for (const name of name_sync) {
    const bk = boneKeys_by_name[name];
    if (!bk) continue;
    let f = 0;
    const bk_keys = bk.keys;
    const bk_keys_full = bk.keys_full;
    bk_keys.forEach((k, idx) => {
      const _f = Math.round(k.time * 30);
      if ((_f > f) && (idx > 0)) {
        let k_last = bk_keys[idx - 1];
        const _f_last = Math.round(k_last.time * 30);
        const _f_diff = _f - _f_last;
        for (let i = 1; i < _f_diff; i++) {
          const k_new = {
            time: (_f_last + i) / 30,
            pos: v1.fromArray(k_last.pos).lerp(v2.fromArray(k.pos), i / _f_diff).toArray(),
            rot: q1.fromArray(k_last.rot).slerp(q2.fromArray(k.rot), i / _f_diff).toArray()
          };
          bk_keys_full.push(k_new);
        }
      }
      bk_keys_full.push(k);
      f++;
    });
    if (bk_keys_full.length < f_max) {
      const k_last = bk_keys_full[bk_keys_full.length - 1];
      for (let i = bk_keys_full.length; i < f_max; i++) {
        const k = Object.assign({}, k_last);
        k.time = i / 30;
        bk_keys_full.push(k);
      }
    }
  }

  const tracks = [];
  const leg_scale = model.para.left_leg_length / MMD_SA_options.model_para_obj.left_leg_length;

  for (const name_MMD in boneKeys_by_name) {
    let name = VRM.bone_map_MMD_to_VRM[name_MMD];
    let name_MMD_translated = name_MMD;
    if (!name && (name_MMD.indexOf('足ＩＫ') != -1)) {
      name_MMD_translated = name_MMD.charAt(0) + '足首';
      name = VRM.bone_map_MMD_to_VRM[name_MMD_translated];
    }

    if (name) {
      const d = (/(left|right)LowerArm/.test(name)) ? ((RegExp.$1 == 'left') ? '左' : '右') : null;
      const keys = (boneKeys_by_name[name_MMD].keys_full.length) ? boneKeys_by_name[name_MMD].keys_full : boneKeys_by_name[name_MMD].keys;

      let times = [];
      let q_values = [];
      let v_values = [];

      keys.forEach((k, f) => {
        let q_multiply, q_premultiply;

        if (name == 'hips') {
          const pos = v1.fromArray(k.pos);
          const bone_move = boneKeys_by_name['全ての親'];
          if (bone_move) {
            pos.add(v2.fromArray(bone_move.keys_full[f].pos));
          }
          pos.multiplyScalar(1 / VRM.vrm_scale);
          pos.multiplyScalar(leg_scale);
          pos.add(v2.fromArray(model.para.pos0['hips']));
          v_values.push(...model.process_position(pos).toArray());

          const bone_lower_body = boneKeys_by_name['下半身'];
          if (bone_lower_body)
            q_multiply = bone_lower_body.keys_full[f].rot;
        }
        else if (name == 'spine') {
          const bone_lower_body = boneKeys_by_name['下半身'];
          if (bone_lower_body)
            q_premultiply = q1.fromArray(bone_lower_body.keys_full[f].rot).conjugate().toArray();
        }
        else if (d) {
          const bone_twist = boneKeys_by_name[d + '手捩'];
          if (bone_twist)
            q_multiply = bone_twist.keys_full[f].rot;
        }

        const q = q1.fromArray(k.rot);
        if (q_multiply)
          q.multiply(q2.fromArray(q_multiply));
        if (q_premultiply)
          q.premultiply(q2.fromArray(q_premultiply));

        q_values.push(...model.process_rotation(q).toArray());
        times.push(k.time);
      });

      const bone_node = model.get_bone_by_MMD_name(name_MMD_translated);
      if (!bone_node) continue;
      const node_name = bone_node.name;

      if (v_values.length)
        tracks.push(new THREEX_THREE.VectorKeyframeTrack(node_name + '.position', times, v_values));
      tracks.push(new THREEX_THREE.QuaternionKeyframeTrack(node_name + '.quaternion', times, q_values));
    }
  }

  return new THREEX_THREE.AnimationClip('trim-preview', time_max, tracks);
}

// --- Playback ---
function startPlayback() {
  if (!lastVmdRef || isPlaying) return;
  const status = document.getElementById('xra-trim-status');
  try {
    const modelX = MMD_SA.THREEX.get_model(0);
    if (!modelX) { status.textContent = 'ERR: no model'; status.classList.add('visible'); return; }

    const trimmedVMD = applyTrim(lastVmdRef);
    const clip = buildClipFromVMD(trimmedVMD);
    console.log('[XRA Trim] clip:', clip.duration, 'tracks:', clip.tracks.length, clip.tracks.slice(0,3).map(t=>t.name));

    if (!clip.tracks.length) { status.textContent = 'ERR: 0 tracks built'; status.classList.add('visible'); return; }

    modelX.animation.add_clip(clip);
    modelX.animation.enabled = true;

    status.textContent = 'Playing (' + clip.tracks.length + ' tracks, ' + (trimEnd - trimStart).toFixed(1) + 's)';
    status.classList.add('visible');

    isPlaying = true;
    updatePlayButton();
    startPlayheadTracker();
  } catch (err) {
    console.error('[XRA Trim] playback failed', err);
    status.textContent = 'ERR: ' + err.message;
    status.classList.add('visible');
  }
}

function stopPlayback() {
  if (!isPlaying) return;
  try {
    const modelX = MMD_SA.THREEX.get_model(0);
    if (modelX) modelX.animation.enabled = false;
  } catch (err) {}
  isPlaying = false;
  stopPlayheadTracker();
  updatePlayButton();
}

function updatePlayButton() {
  const btn = document.getElementById('xra-trim-play');
  if (btn) btn.textContent = isPlaying ? 'Stop' : 'Play';
}

function startPlayheadTracker() {
  stopPlayheadTracker();
  const trimDuration = trimEnd - trimStart;
  function tick() {
    if (!isPlaying) return;
    try {
      const modelX = MMD_SA.THREEX.get_model(0);
      if (modelX && modelX.animation.enabled) {
        const t = modelX.animation.time;
        if (playheadEl) {
          playheadEl.style.left = pctFromTime(trimStart + t) + '%';
          playheadEl.style.display = 'block';
        }
        if (t >= trimDuration) {
          stopPlayback();
          return;
        }
      }
    } catch (err) {}
    playheadRAF = requestAnimationFrame(tick);
  }
  playheadRAF = requestAnimationFrame(tick);
}

function stopPlayheadTracker() {
  if (playheadRAF) {
    cancelAnimationFrame(playheadRAF);
    playheadRAF = null;
  }
  if (playheadEl) playheadEl.style.display = 'none';
}

// --- Trim + apply ---
function applyTrim(vmd) {
  const filterRebase = (keys) => keys
    .filter(k => k.time >= trimStart && k.time <= trimEnd)
    .map(k => Object.assign({}, k, { time: k.time - trimStart }));

  return {
    boneKeys: filterRebase(vmd.boneKeys || []),
    morphKeys: filterRebase(vmd.morphKeys || []),
  };
}

// --- UI ---
function pctFromTime(t) {
  return clipDuration ? (t / clipDuration) * 100 : 0;
}
function timeFromClientX(clientX) {
  const rect = timelineEl.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return pct * clipDuration;
}

function render() {
  startHandle.style.left = pctFromTime(trimStart) + '%';
  endHandle.style.left = pctFromTime(trimEnd) + '%';
  rangeEl.style.left = pctFromTime(trimStart) + '%';
  rangeEl.style.width = (pctFromTime(trimEnd) - pctFromTime(trimStart)) + '%';
  document.getElementById('xra-trim-start-label').textContent = trimStart.toFixed(2) + 's';
  document.getElementById('xra-trim-end-label').textContent = trimEnd.toFixed(2) + 's';
  document.getElementById('xra-trim-duration-label').textContent = (trimEnd - trimStart).toFixed(2) + 's kept of ' + clipDuration.toFixed(2) + 's';
}

function onPointerDown(which) {
  return function (e) {
    dragging = which;
    e.preventDefault();
  };
}

function onPointerMove(e) {
  if (!dragging) return;
  const t = timeFromClientX(e.clientX);
  if (dragging === 'start') {
    trimStart = Math.min(t, trimEnd - 0.01);
    trimStart = Math.max(0, trimStart);
  } else if (dragging === 'end') {
    trimEnd = Math.max(t, trimStart + 0.01);
    trimEnd = Math.min(clipDuration, trimEnd);
  }
  render();
}

function onPointerUp() {
  dragging = null;
}

function open(vmd) {
  clipDuration = boneKeysDuration(vmd);
  if (clipDuration <= 0) return;
  trimStart = 0;
  trimEnd = clipDuration;
  lastVmdRef = vmd;
  window.XRA_trimmedVMD = null;

  root.classList.add('open');
  render();

  // Pause live webcam mocap so it doesn't fight the preview.
  try {
    const camera = System._browser && System._browser.camera;
    if (camera) {
      savedDetectorState = {
        poseNet: camera.poseNet && camera.poseNet.enabled,
        facemesh: camera.facemesh && camera.facemesh.enabled,
        handpose: camera.handpose && camera.handpose.enabled,
      };
      if (camera.poseNet) camera.poseNet.enabled = false;
      if (camera.facemesh) camera.facemesh.enabled = false;
      if (camera.handpose) camera.handpose.enabled = false;
    }
  } catch (err) {}
}

function close() {
  stopPlayback();
  root.classList.remove('open');

  // Auto-apply trim on close so exports use the trimmed range
  if (lastVmdRef && (trimStart > 0 || trimEnd < clipDuration)) {
    window.XRA_trimmedVMD = applyTrim(lastVmdRef);
  }

  try {
    if (savedDetectorState) {
      const camera = System._browser.camera;
      if (camera.poseNet) camera.poseNet.enabled = savedDetectorState.poseNet;
      if (camera.facemesh) camera.facemesh.enabled = savedDetectorState.facemesh;
      if (camera.handpose) camera.handpose.enabled = savedDetectorState.handpose;
      savedDetectorState = null;
    }
  } catch (err) {}
}

function onApply() {
  if (!lastVmdRef) return;
  window.XRA_trimmedVMD = applyTrim(lastVmdRef);
  const status = document.getElementById('xra-trim-status');
  status.textContent = 'Trim applied - exports will use the trimmed range until you record again.';
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 4000);
}

function onReset() {
  trimStart = 0;
  trimEnd = clipDuration;
  window.XRA_trimmedVMD = null;
  render();
}

function onPlayToggle() {
  if (isPlaying) stopPlayback();
  else startPlayback();
}

function buildDOM() {
  root = document.createElement('div');
  root.id = 'xra-trim-overlay';
  root.innerHTML = `
    <div class="xra-trim-panel">
      <div class="xra-trim-title">Trim Recording</div>
      <div class="xra-trim-sub" id="xra-trim-duration-label"></div>
      <div class="xra-trim-timeline" id="xra-trim-timeline">
        <div class="xra-trim-range" id="xra-trim-range"></div>
        <div class="xra-trim-playhead" id="xra-trim-playhead"></div>
        <div class="xra-trim-handle" id="xra-trim-start" title="Start"></div>
        <div class="xra-trim-handle" id="xra-trim-end" title="End"></div>
      </div>
      <div class="xra-trim-labels">
        <span id="xra-trim-start-label"></span>
        <span id="xra-trim-end-label"></span>
      </div>
      <div class="xra-trim-status" id="xra-trim-status"></div>
      <div class="xra-trim-actions">
        <button id="xra-trim-play">Play</button>
        <button id="xra-trim-reset">Reset</button>
        <button id="xra-trim-apply" class="primary">Apply Trim</button>
        <button id="xra-trim-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  timelineEl = document.getElementById('xra-trim-timeline');
  rangeEl = document.getElementById('xra-trim-range');
  startHandle = document.getElementById('xra-trim-start');
  endHandle = document.getElementById('xra-trim-end');
  playheadEl = document.getElementById('xra-trim-playhead');

  startHandle.addEventListener('pointerdown', onPointerDown('start'));
  endHandle.addEventListener('pointerdown', onPointerDown('end'));
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  document.getElementById('xra-trim-play').addEventListener('click', onPlayToggle);
  document.getElementById('xra-trim-apply').addEventListener('click', onApply);
  document.getElementById('xra-trim-reset').addEventListener('click', onReset);
  document.getElementById('xra-trim-close').addEventListener('click', close);
}

let hadVmd = false;
function pollRecorder() {
  if (!isEngineReady()) return;
  const vmd = System._browser.camera.motion_recorder.vmd;
  if (vmd && !hadVmd) {
    open(vmd);
  }
  hadVmd = !!vmd;
}

function init() {
  buildDOM();
  setInterval(pollRecorder, 500);
}

window.XRA_openTrim = function (vmd) {
  vmd = vmd || System._browser.camera.motion_recorder.vmd;
  if (vmd) open(vmd);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
})();
