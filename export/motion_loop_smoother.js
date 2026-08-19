// Smooths the tail of an animation clip toward frame 0 for seamless looping.
// Mutates clip in place and returns it.

function Motion_Clip_SmoothLoopSeam(clip, seamSeconds) {
  if (seamSeconds === undefined) seamSeconds = 0.4;
  if (clip.duration <= seamSeconds) return clip;

  var seamStart = clip.duration - seamSeconds;

  for (var i = 0; i < clip.tracks.length; i++) {
    var track = clip.tracks[i];
    var times = track.times;
    var values = track.values;
    var valueSize = track.getValueSize();
    var isQuat = (valueSize === 4) || (track.name.indexOf('.quaternion') !== -1);

    // Find the first frame index inside the seam region
    var seamIdx = 0;
    for (var j = 0; j < times.length; j++) {
      if (times[j] >= seamStart) {
        seamIdx = j;
        break;
      }
    }

    // Frame 0 target values
    var target = values.slice(0, valueSize);

    if (isQuat) {
      var qOrig = new THREE.Quaternion();
      var qTarget = new THREE.Quaternion(target[0], target[1], target[2], target[3]);

      for (var j = seamIdx; j < times.length; j++) {
        var t = (times[j] - seamStart) / seamSeconds;
        var blend = t * t * (3 - 2 * t); // smoothstep

        var offset = j * valueSize;
        qOrig.set(values[offset], values[offset + 1], values[offset + 2], values[offset + 3]);
        qOrig.slerp(qTarget, blend);
        values[offset]     = qOrig.x;
        values[offset + 1] = qOrig.y;
        values[offset + 2] = qOrig.z;
        values[offset + 3] = qOrig.w;
      }
    } else {
      for (var j = seamIdx; j < times.length; j++) {
        var t = (times[j] - seamStart) / seamSeconds;
        var blend = t * t * (3 - 2 * t); // smoothstep

        var offset = j * valueSize;
        for (var k = 0; k < valueSize; k++) {
          values[offset + k] = values[offset + k] * (1 - blend) + target[k] * blend;
        }
      }
    }
  }

  return clip;
}
