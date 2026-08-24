// Motion trim overlay - lets the user pick a start/end time range on a
// recorded mocap clip before export, so e.g. walking back to the laptop
// to stop recording doesn't end up baked into the exported animation.
// Standalone vanilla-JS overlay in the spirit of ui/app.js, but scoped
// just to this one step. Watches motion_recorder.vmd from the outside
// instead of hooking into the numpad action handlers, so it needs zero
// changes to the existing record button / dialogue-tree code.
(function () {
'use strict';

let root, timelineEl, startHandle, endHandle, rangeEl, playheadEl;
let clipDuration = 0;
let trimStart = 0, trimEnd = 0;
let dragging = null;

let previewAction, previewClip;
let lastVmdRef = null;
let savedAnimState = null;
let savedDetectorState = null;

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

// --- Scrub preview ---
// Build a THREE.AnimationClip from the recorded boneKeys via the same
// BVH_FileWriter + BVHLoader pipeline used for FBX export, then inject it
// into the MODEL'S OWN animation mixer (modelX.animation.mixer). This is
// critical: the engine calls modelX.animation.mixer.update(delta) every
// frame as part of its render loop (MMD_SA.js ~line 9437) but ONLY when
// animation.enabled is true. A separate mixer would never get ticked by
// the engine and its pose would be overwritten on the very next frame by
// the engine's per-bone MMD copy loop (which runs when animation_enabled
// is false). Using the model's mixer means our clip is applied every
// frame automatically, and with animation_enabled=true + ML_enabled=false
// the per-bone overwrite loop is skipped entirely.
async function setupPreview(vmd) {
  teardownPreview();

  try {
    await System._browser.load_script(toFileProtocol(System.Gadget.path + '/export/BVH_filewriter.js'));
    const module_bvh = await System._browser.load_script(System.Gadget.path + '/three/loaders/_BVHLoader.js', true);
    const loader = new module_bvh.BVHLoader();
    const bvh_txt = BVH_FileWriter(null, vmd.boneKeys);
    const bvh = loader.parse(bvh_txt);

    const modelX = MMD_SA.THREEX.get_model(0);
    if (!modelX) return;

    // Remap BVH track names (VRM humanoid keys like "hips") to actual
    // Object3D.name values in the scene (e.g. "J_Bip_C_Hips").
    const nameToObjectName = {};
    for (const objName in (modelX.bone_three_to_vrm_name || {})) {
      nameToObjectName[modelX.bone_three_to_vrm_name[objName]] = objName;
    }
    bvh.clip.tracks.forEach(track => {
      const dot = track.name.indexOf('.');
      const boneName = track.name.slice(0, dot);
      const prop = track.name.slice(dot);
      const realName = nameToObjectName[boneName];
      if (realName) track.name = realName + prop;
    });

    previewClip = bvh.clip;

    // Save current animation state and take over the model's mixer.
    savedAnimState = {
      wasEnabled: modelX.animation.enabled,
      actionIndex: modelX.animation.action_index,
      motionIndex: modelX.animation._motion_index,
    };

    // Ensure animation.enabled = true so the engine ticks the mixer.
    if (!modelX.animation.enabled) {
      modelX.animation.enabled = true;
    }
    // Stop whatever was playing (idle anim, etc.)
    modelX.animation.mixer.stopAllAction();
    // Prevent the engine's auto-toggle at MMD_SA.js:9386-9394 from
    // flipping animation.enabled back off mid-trim.
    modelX.animation._motion_index = null;

    // Play our preview clip in paused mode — the mixer evaluates it at
    // action.time every frame without auto-advancing.
    previewAction = modelX.animation.mixer.clipAction(previewClip);
    previewAction.clampWhenFinished = true;
    previewAction.loop = MMD_SA.THREEX.THREE.LoopOnce;
    previewAction.play();
    previewAction.paused = true;
    previewAction.time = 0;
  }
  catch (err) {
    console.error('[XRA Trim] preview setup failed', err);
  }
}

function teardownPreview() {
  if (previewAction) {
    try {
      const modelX = MMD_SA.THREEX.get_model(0);
      previewAction.stop();
      modelX.animation.mixer.uncacheClip(previewClip);
      modelX.animation.mixer.uncacheAction(previewClip);

      if (savedAnimState) {
        modelX.animation._motion_index = savedAnimState.motionIndex;
        if (!savedAnimState.wasEnabled) {
          modelX.animation.enabled = false;
        } else if (savedAnimState.actionIndex >= 0) {
          modelX.animation.play(savedAnimState.actionIndex);
        }
        savedAnimState = null;
      }
    } catch (err) {}
    previewAction = previewClip = null;
  }
}

function scrubTo(t) {
  if (!previewAction) return;
  previewAction.time = Math.max(0, Math.min(t, clipDuration || 0.0001));
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
  scrubTo(dragging === 'start' ? trimStart : trimEnd);
}

function onPointerUp() {
  dragging = null;
}

function onTimelineScrub(e) {
  if (dragging) return;
  scrubTo(timeFromClientX(e.clientX));
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

  // Pause live webcam mocap so tracked rotations don't fight the preview.
  // With animation_enabled=true (set inside setupPreview) and ML_enabled=false,
  // the engine's per-bone MMD copy loop is skipped entirely — but we still
  // need to disable the detectors so they don't write to the jThree MMD bones
  // which would cause subtle drift if animation is re-enabled later.
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

  setupPreview(vmd);
}

function close() {
  root.classList.remove('open');
  teardownPreview();

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

function buildDOM() {
  root = document.createElement('div');
  root.id = 'xra-trim-overlay';
  root.innerHTML = `
    <div class="xra-trim-panel">
      <div class="xra-trim-title">Trim Recording</div>
      <div class="xra-trim-sub" id="xra-trim-duration-label"></div>
      <div class="xra-trim-timeline" id="xra-trim-timeline">
        <div class="xra-trim-range" id="xra-trim-range"></div>
        <div class="xra-trim-handle" id="xra-trim-start" title="Start"></div>
        <div class="xra-trim-handle" id="xra-trim-end" title="End"></div>
      </div>
      <div class="xra-trim-labels">
        <span id="xra-trim-start-label"></span>
        <span id="xra-trim-end-label"></span>
      </div>
      <div class="xra-trim-status" id="xra-trim-status"></div>
      <div class="xra-trim-actions">
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

  startHandle.addEventListener('pointerdown', onPointerDown('start'));
  endHandle.addEventListener('pointerdown', onPointerDown('end'));
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  timelineEl.addEventListener('click', onTimelineScrub);

  document.getElementById('xra-trim-apply').addEventListener('click', onApply);
  document.getElementById('xra-trim-reset').addEventListener('click', onReset);
  document.getElementById('xra-trim-close').addEventListener('click', close);
}

// Poll motion_recorder.vmd - open the trim UI automatically the moment a
// recording finishes (vmd goes from null to populated).
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

// Manual re-open (e.g. if closed without applying, or to re-trim the last
// recording) without needing a fresh recording.
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
