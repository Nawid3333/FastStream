// The picture's aspect ratio (upstream #552, Andrews54757/FastStream, 2026-10-09): auto is
// the video's own; a ratio shows the picture in a box of that shape, stretched to it (a 4:3
// show at 16:9 has no bars beside it); stretch fills the player.
export const AspectRatios = {
  'AUTO': 'auto',
  '16:9': '16:9',
  '4:3': '4:3',
  '21:9': '21:9',
  '1:1': '1:1',
  '9:16': '9:16',
  '3:2': '3:2',
  '16:10': '16:10',
  'STRETCH': 'stretch',
};
