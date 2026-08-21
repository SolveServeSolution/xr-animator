// FBX ASCII 7.4 writer — exports a THREE.AnimationClip as a Mixamo-rigged FBX file.
// Global function, no module exports.

function FBX_Mixamo_FileWriter(filename, clip, skeleton, includeRootMotion) {
  // --- Thumb relabel correction ---
  // BVH_FileWriter renames thumbs like so:
  //   leftThumbProximal → leftThumbMetacarpal
  //   leftThumbIntermediate → leftThumbProximal
  //   leftThumbDistal → leftThumbIntermediate
  // We must UNDO that before mapping to Mixamo names.
  var thumbCorrection = {
    'leftThumbMetacarpal': 'leftThumbProximal',
    'leftThumbProximal': 'leftThumbIntermediate',
    'leftThumbIntermediate': 'leftThumbDistal',
    'rightThumbMetacarpal': 'rightThumbProximal',
    'rightThumbProximal': 'rightThumbIntermediate',
    'rightThumbIntermediate': 'rightThumbDistal'
  };

  // --- VRM bone name → Mixamo bone name ---
  var vrmToMixamo = {
    'hips': 'mixamorigHips',
    'spine': 'mixamorigSpine',
    'chest': 'mixamorigSpine1',
    'upperChest': 'mixamorigSpine2',
    'neck': 'mixamorigNeck',
    'head': 'mixamorigHead',
    'leftEye': 'mixamorigLeftEye',
    'rightEye': 'mixamorigRightEye',
    'leftShoulder': 'mixamorigLeftShoulder',
    'leftUpperArm': 'mixamorigLeftArm',
    'leftLowerArm': 'mixamorigLeftForeArm',
    'leftHand': 'mixamorigLeftHand',
    'rightShoulder': 'mixamorigRightShoulder',
    'rightUpperArm': 'mixamorigRightArm',
    'rightLowerArm': 'mixamorigRightForeArm',
    'rightHand': 'mixamorigRightHand',
    'leftUpperLeg': 'mixamorigLeftUpLeg',
    'leftLowerLeg': 'mixamorigLeftLeg',
    'leftFoot': 'mixamorigLeftFoot',
    'leftToes': 'mixamorigLeftToeBase',
    'rightUpperLeg': 'mixamorigRightUpLeg',
    'rightLowerLeg': 'mixamorigRightLeg',
    'rightFoot': 'mixamorigRightFoot',
    'rightToes': 'mixamorigRightToeBase',
    // Left hand fingers
    'leftThumbProximal': 'mixamorigLeftHandThumb1',
    'leftThumbIntermediate': 'mixamorigLeftHandThumb2',
    'leftThumbDistal': 'mixamorigLeftHandThumb3',
    'leftIndexProximal': 'mixamorigLeftHandIndex1',
    'leftIndexIntermediate': 'mixamorigLeftHandIndex2',
    'leftIndexDistal': 'mixamorigLeftHandIndex3',
    'leftMiddleProximal': 'mixamorigLeftHandMiddle1',
    'leftMiddleIntermediate': 'mixamorigLeftHandMiddle2',
    'leftMiddleDistal': 'mixamorigLeftHandMiddle3',
    'leftRingProximal': 'mixamorigLeftHandRing1',
    'leftRingIntermediate': 'mixamorigLeftHandRing2',
    'leftRingDistal': 'mixamorigLeftHandRing3',
    'leftLittleProximal': 'mixamorigLeftHandPinky1',
    'leftLittleIntermediate': 'mixamorigLeftHandPinky2',
    'leftLittleDistal': 'mixamorigLeftHandPinky3',
    // Right hand fingers
    'rightThumbProximal': 'mixamorigRightHandThumb1',
    'rightThumbIntermediate': 'mixamorigRightHandThumb2',
    'rightThumbDistal': 'mixamorigRightHandThumb3',
    'rightIndexProximal': 'mixamorigRightHandIndex1',
    'rightIndexIntermediate': 'mixamorigRightHandIndex2',
    'rightIndexDistal': 'mixamorigRightHandIndex3',
    'rightMiddleProximal': 'mixamorigRightHandMiddle1',
    'rightMiddleIntermediate': 'mixamorigRightHandMiddle2',
    'rightMiddleDistal': 'mixamorigRightHandMiddle3',
    'rightRingProximal': 'mixamorigRightHandRing1',
    'rightRingIntermediate': 'mixamorigRightHandRing2',
    'rightRingDistal': 'mixamorigRightHandRing3',
    'rightLittleProximal': 'mixamorigRightHandPinky1',
    'rightLittleIntermediate': 'mixamorigRightHandPinky2',
    'rightLittleDistal': 'mixamorigRightHandPinky3'
  };

  function resolveBoneName(name) {
    var corrected = thumbCorrection[name] || name;
    return vrmToMixamo[corrected] || null;
  }

  // --- ID generator ---
  var nextId = 1000000000;
  function genId() { return nextId++; }

  // --- Euler from quaternion (ZYX intrinsic order, degrees) ---
  function quatToEulerZYX(x, y, z, w) {
    var sinr_cosp = 2 * (w * x + y * z);
    var cosr_cosp = 1 - 2 * (x * x + y * y);
    var roll = Math.atan2(sinr_cosp, cosr_cosp);

    var sinp = 2 * (w * y - z * x);
    var pitch;
    if (Math.abs(sinp) >= 1) {
      pitch = Math.sign(sinp) * Math.PI / 2;
    } else {
      pitch = Math.asin(sinp);
    }

    var siny_cosp = 2 * (w * z + x * y);
    var cosy_cosp = 1 - 2 * (y * y + z * z);
    var yaw = Math.atan2(siny_cosp, cosy_cosp);

    var RAD2DEG = 180 / Math.PI;
    return [roll * RAD2DEG, pitch * RAD2DEG, yaw * RAD2DEG];
  }

  // --- Build bone list from skeleton ---
  var bones = skeleton.bones;
  var boneDataList = [];
  var rootBoneIndex = -1;

  for (var i = 0; i < bones.length; i++) {
    var bone = bones[i];
    var vrmName = bone.name;
    var mixamoName = resolveBoneName(vrmName);
    if (!mixamoName) continue;

    var isRoot = !bone.parent || bones.indexOf(bone.parent) === -1;
    if (isRoot && rootBoneIndex === -1) rootBoneIndex = boneDataList.length;

    boneDataList.push({
      index: i,
      bone: bone,
      vrmName: vrmName,
      mixamoName: mixamoName,
      isRoot: isRoot,
      modelId: genId()
    });
  }

  // --- Collect tracks per bone ---
  for (var bi = 0; bi < boneDataList.length; bi++) {
    var bd = boneDataList[bi];
    bd.rotationTrack = null;
    bd.positionTrack = null;

    for (var ti = 0; ti < clip.tracks.length; ti++) {
      var track = clip.tracks[ti];
      var trackBoneName = track.name.split('.')[0];
      if (trackBoneName !== bd.bone.name) continue;

      if (track.name.endsWith('.quaternion')) {
        bd.rotationTrack = track;
      } else if (track.name.endsWith('.position') && bd.isRoot) {
        bd.positionTrack = track;
      }
    }
  }

  // --- FBX time: 1 second = 46186158000 (FBX time unit) ---
  var FBX_TIME_UNIT = 46186158000;

  // --- Build FBX ASCII ---
  // three.js FBXLoader's ASCII TextParser tracks nesting depth by counting
  // literal TAB characters at the start of each line (one tab per depth
  // level) - space indentation is silently ignored, which drops all nested
  // content (Connections, Objects, curve data) and leaves e.g.
  // fbxTree.Connections.connections undefined downstream. L() therefore
  // tracks depth itself from brace characters and emits real tabs.
  var lines = [];
  var depth = 0;

  function L(s) {
    var t = s.replace(/^\s+/, '');
    if (t === '}') depth--;
    lines.push(new Array(depth + 1).join('\t') + t);
    if (/\{$/.test(t)) depth++;
  }

  // Header
  L('; FBX 7.4.0 project file');
  L('; Generated by FBX_Mixamo_FileWriter');
  L('FBXHeaderExtension:  {');
  L('  FBXHeaderVersion: 1003');
  L('  FBXVersion: 7400');
  L('  Creator: "SystemAnimatorOnline FBX Mixamo Exporter"');
  L('}');
  L('');

  // Global settings
  L('GlobalSettings:  {');
  L('  Version: 1000');
  L('  Properties70:  {');
  L('    P: "UpAxis", "int", "Integer", "",1');
  L('    P: "UpAxisSign", "int", "Integer", "",1');
  L('    P: "FrontAxis", "int", "Integer", "",2');
  L('    P: "FrontAxisSign", "int", "Integer", "",1');
  L('    P: "CoordAxis", "int", "Integer", "",0');
  L('    P: "CoordAxisSign", "int", "Integer", "",1');
  L('    P: "OriginalUpAxis", "int", "Integer", "",1');
  L('    P: "OriginalUpAxisSign", "int", "Integer", "",1');
  L('    P: "UnitScaleFactor", "double", "Number", "",1');
  L('    P: "OriginalUnitScaleFactor", "double", "Number", "",1');
  L('    P: "TimeMode", "enum", "", "",6');
  L('    P: "CustomFrameRate", "double", "Number", "",30');
  L('  }');
  L('}');
  L('');

  // Objects
  L('Objects:  {');

  // Model nodes (LimbNode)
  for (var bi = 0; bi < boneDataList.length; bi++) {
    var bd = boneDataList[bi];
    var pos = bd.bone.position;
    L('  Model: ' + bd.modelId + ', "Model::' + bd.mixamoName + '", "LimbNode" {');
    L('    Version: 232');
    L('    Properties70:  {');
    L('      P: "RotationOrder", "enum", "", "",0');
    L('      P: "InheritType", "enum", "", "",1');
    L('      P: "ScalingMax", "Vector3D", "Vector", "",0,0,0');
    L('      P: "DefaultAttributeIndex", "int", "Integer", "",0');
    L('      P: "Lcl Translation", "Lcl Translation", "", "A",' + pos.x + ',' + pos.y + ',' + pos.z);
    L('    }');
    L('    Shading: Y');
    L('    Culling: "CullingOff"');
    L('  }');
  }

  // AnimationStack
  var animStackId = genId();
  var animLayerId = genId();
  var duration = clip.duration;

  L('  AnimationStack: ' + animStackId + ', "AnimStack::mixamo.com", "" {');
  L('    Properties70:  {');
  L('      P: "LocalStart", "KTime", "Time", "",0');
  L('      P: "LocalStop", "KTime", "Time", "",' + Math.round(duration * FBX_TIME_UNIT));
  L('      P: "ReferenceStart", "KTime", "Time", "",0');
  L('      P: "ReferenceStop", "KTime", "Time", "",' + Math.round(duration * FBX_TIME_UNIT));
  L('    }');
  L('  }');

  // AnimationLayer
  L('  AnimationLayer: ' + animLayerId + ', "AnimLayer::BaseLayer", "" {');
  L('  }');

  // AnimationCurveNodes and AnimationCurves per bone
  var curveNodeData = [];

  for (var bi = 0; bi < boneDataList.length; bi++) {
    var bd = boneDataList[bi];

    // Rotation curves
    if (bd.rotationTrack) {
      var rotCurveNodeId = genId();
      var rotCurveIds = [genId(), genId(), genId()];

      L('  AnimationCurveNode: ' + rotCurveNodeId + ', "AnimCurveNode::R", "" {');
      L('    Properties70:  {');
      L('      P: "d|X", "Number", "", "A",0');
      L('      P: "d|Y", "Number", "", "A",0');
      L('      P: "d|Z", "Number", "", "A",0');
      L('    }');
      L('  }');

      var track = bd.rotationTrack;
      var numKeys = track.times.length;
      var eulerX = [], eulerY = [], eulerZ = [], times = [];

      for (var k = 0; k < numKeys; k++) {
        var offset = k * 4;
        var qx = track.values[offset];
        var qy = track.values[offset + 1];
        var qz = track.values[offset + 2];
        var qw = track.values[offset + 3];
        var euler = quatToEulerZYX(qx, qy, qz, qw);
        eulerX.push(euler[0]);
        eulerY.push(euler[1]);
        eulerZ.push(euler[2]);
        times.push(Math.round(track.times[k] * FBX_TIME_UNIT));
      }

      var axes = [eulerX, eulerY, eulerZ];
      for (var a = 0; a < 3; a++) {
        L('  AnimationCurve: ' + rotCurveIds[a] + ', "AnimCurve::", "" {');
        L('    Default: 0');
        L('    KeyVer: 4009');
        L('    KeyTime: *' + numKeys + ' {');
        L('      a: ' + times.join(','));
        L('    }');
        L('    KeyValueFloat: *' + numKeys + ' {');
        L('      a: ' + axes[a].join(','));
        L('    }');
        L('  }');
      }

      curveNodeData.push({
        type: 'rotation',
        curveNodeId: rotCurveNodeId,
        curveIds: rotCurveIds,
        modelId: bd.modelId
      });
    }

    // Position curves (root only, opt-in - off by default so the model
    // plays the animation in place without moving/sliding position)
    if (includeRootMotion && bd.positionTrack && bd.isRoot) {
      var posCurveNodeId = genId();
      var posCurveIds = [genId(), genId(), genId()];

      L('  AnimationCurveNode: ' + posCurveNodeId + ', "AnimCurveNode::T", "" {');
      L('    Properties70:  {');
      L('      P: "d|X", "Number", "", "A",0');
      L('      P: "d|Y", "Number", "", "A",0');
      L('      P: "d|Z", "Number", "", "A",0');
      L('    }');
      L('  }');

      var track = bd.positionTrack;
      var numKeys = track.times.length;
      var posX = [], posY = [], posZ = [], times = [];

      for (var k = 0; k < numKeys; k++) {
        var offset = k * 3;
        posX.push(track.values[offset]);
        posY.push(track.values[offset + 1]);
        posZ.push(track.values[offset + 2]);
        times.push(Math.round(track.times[k] * FBX_TIME_UNIT));
      }

      var axes = [posX, posY, posZ];
      for (var a = 0; a < 3; a++) {
        L('  AnimationCurve: ' + posCurveIds[a] + ', "AnimCurve::", "" {');
        L('    Default: 0');
        L('    KeyVer: 4009');
        L('    KeyTime: *' + numKeys + ' {');
        L('      a: ' + times.join(','));
        L('    }');
        L('    KeyValueFloat: *' + numKeys + ' {');
        L('      a: ' + axes[a].join(','));
        L('    }');
        L('  }');
      }

      curveNodeData.push({
        type: 'translation',
        curveNodeId: posCurveNodeId,
        curveIds: posCurveIds,
        modelId: bd.modelId
      });
    }
  }

  L('}');
  L('');

  // Connections
  L('Connections:  {');

  // AnimLayer → AnimStack
  L('  C: "OO",' + animLayerId + ',' + animStackId);

  // Model hierarchy - each bone connects to its actual parent bone
  // (falling back to scene root 0 for the skeleton root)
  var modelIdByBone = new Map();
  for (var bi = 0; bi < boneDataList.length; bi++) {
    modelIdByBone.set(boneDataList[bi].bone, boneDataList[bi].modelId);
  }
  for (var bi = 0; bi < boneDataList.length; bi++) {
    var bd = boneDataList[bi];
    var parentModelId = bd.bone.parent ? modelIdByBone.get(bd.bone.parent) : undefined;
    L('  C: "OO",' + bd.modelId + ',' + (parentModelId !== undefined ? parentModelId : 0));
  }

  // CurveNode → AnimLayer, CurveNode → Model, Curve → CurveNode
  for (var ci = 0; ci < curveNodeData.length; ci++) {
    var cn = curveNodeData[ci];
    // CurveNode → AnimLayer
    L('  C: "OO",' + cn.curveNodeId + ',' + animLayerId);
    // CurveNode → Model (property link)
    var prop = (cn.type === 'rotation') ? 'Lcl Rotation' : 'Lcl Translation';
    L('  C: "OP",' + cn.curveNodeId + ',' + cn.modelId + ', "' + prop + '"');
    // Curves → CurveNode
    var axisNames = ['d|X', 'd|Y', 'd|Z'];
    for (var a = 0; a < 3; a++) {
      L('  C: "OP",' + cn.curveIds[a] + ',' + cn.curveNodeId + ', "' + axisNames[a] + '"');
    }
  }

  L('}');

  // --- Save file ---
  var content = lines.join('\n');
  var blob = new Blob([content], { type: 'application/octet-stream' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
