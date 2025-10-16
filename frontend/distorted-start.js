
function addDraggablePolygon(viewer) {
  const positions = [
    Cesium.Cartesian3.fromDegrees(-75, 35),
    Cesium.Cartesian3.fromDegrees(-75, 40),
    Cesium.Cartesian3.fromDegrees(-70, 40),
    Cesium.Cartesian3.fromDegrees(-70, 35),
  ];

  const points = positions.map(pos =>
    viewer.entities.add({
      position: pos,
      point: { pixelSize: 10, color: Cesium.Color.RED },
    })
  );
  
viewer.entities.add({
  polygon: {
    hierarchy: new Cesium.CallbackProperty(
      () => new Cesium.PolygonHierarchy(points.map(p => p.position.getValue())),
      false
    ),
    material: new Cesium.ImageMaterialProperty({
      image: "nature.jpg",         // your texture
      transparent: true            // keep transparency if PNG
    }),
    classificationType: Cesium.ClassificationType.TERRAIN, // drape onto terrain
    clampToGround: true
  },
});

  let picked;
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction(click => {
    picked = viewer.scene.pick(click.position);
    viewer.scene.screenSpaceCameraController.enableInputs = false;
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction(movement => {
    if (picked && picked.id && points.includes(picked.id)) {
      const cartesian = viewer.camera.pickEllipsoid(movement.endPosition);
      if (cartesian) picked.id.position = cartesian;
    }
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    picked = undefined;
    viewer.scene.screenSpaceCameraController.enableInputs = true;
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  return { points, handler };
}
