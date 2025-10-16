CesiumJS native support

Cesium’s high-level Entity API does not natively support warping an image to an arbitrary polygon. In practice, an ImageMaterialProperty on a PolygonGraphics or RectangleGraphics simply tiles or crops the image within the shape’s bounding box (possibly rotated via stRotation), but cannot stretch the image to fit a four-corner polygon. In fact, Cesium’s polygon material UV coordinates are fixed internally; you can’t assign custom UVs via the Entity API. As one Cesium team member explains: “It isn’t currently possible to control how the texture coordinates are set up when creating polygons with the Entity API.”
community.cesium.com
. Another explains that changing this would require modifying Cesium’s source or using a custom geometry/shader
community.cesium.com
. In short, out of the box, a Cesium Entity.polygon with an image material will not warp the image to match your dragged polygon shape – it will repeat or clamp the image to the polygon’s minimum bounding rectangle. (In practice, images on polygons follow great-circle edges, which can appear “stretched” along the arcs
community.cesium.com
, but still do not truly map a 4-corner image correctly.)

Clamping to terrain adds another limitation. Cesium Entities can clamp solid-colored polygons to terrain, but image materials on entities cannot be draped. In fact, a user reported: “clamping to terrain only currently works for solid colors, not images”
community.cesium.com
. Thus an Entity.polygon with an image will either float or fail to drape under a terrain provider. The low-level GroundPrimitive (draped geometry) also doesn’t give precise texture control. The official docs note that textured GroundPrimitives are meant for simple patterns and not for precise mapping: “Textured GroundPrimitives… are not meant for precisely mapping textures to terrain – for that use case, use SingleTileImageryProvider.”
cesium.com
. Moreover, even the geometry API has no “textureCoordinates” option when clamped to terrain: the PolygonGeometry docs explicitly say that providing a textureCoordinates hierarchy “has no effect for ground primitives.”
cesium.com
.

In summary, CesiumJS has no built-in feature that simply takes an arbitrary 4-corner polygon and warps one image over it while draping on terrain. All discussions and issue reports confirm this gap
community.cesium.com
community.cesium.com
cesium.com
. The typical polygon/rectangle objects will only tile or crop the image, and terrain clamping only works for colors. Thus, achieving a true “image on a polygon as in Google Earth” requires some workaround or custom approach.

Workarounds and alternatives

SingleTileImageryProvider on a rectangle. The closest native feature is to treat the image as a draped rectangular layer, not a polygon. Cesium’s SingleTileImageryProvider lets you overlay one image over a geographic rectangle. For example:

viewer.imageryLayers.addImageryProvider(
  new Cesium.SingleTileImageryProvider({
    url: 'nature.jpg',
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north)
  })
);


This will drape nature.jpg over the specified lat/lon box on the globe
cesium.com
. The image will stretch to cover that entire rectangle, but note the rectangle must be axis-aligned in geographic coordinates. (The official Cesium docs give a similar example using SingleTileImageryProvider.fromUrl
cesium.com
.) If your polygon happens to be a true lat-long rectangle (or close to it), this will overlay the image correctly on terrain. However, for a general trapezoid/quadrilateral, you’d have to pick a rectangle that encloses it – the image won’t “warp” to the slanted corners.

Entity RectangleGraphics (with image material). If you only need a rectangular footprint, you can use Entity.rectangle with material: new Cesium.ImageMaterialProperty({image: 'nature.jpg'}) and clampToGround. This will drape the rectangle on terrain (when supported) and fill it with the image. But again, this only works for perfect lat-lon rectangles. For arbitrary 4-point quads, there is no equivalent Entity.

Custom Primitive or shader. For full generality, you must drop to the Primitive API and/or GLSL. In principle you could create a GeometryInstance of a polygon with your four corners, and assign a custom Appearance (e.g. MaterialAppearance) that uses your image as a texture with manually computed UVs. This means computing the texture coordinates that map your four 3D points to the corners of the image (like a 2-triangle mesh with custom UVs). In practice this is advanced: Cesium’s built-in PolygonGeometry won’t give you control of UVs, so you’d define your own geometry (or even generate a simple mesh or glTF model). The community notes that “you would need to use the lower-level Geometry and Appearances… defining a custom geometry with custom texture coordinates” or export a textured glTF
community.cesium.com
. This essentially means writing your own shader or pre-computing a geometry. (For example, one could use Cesium.Geometry to build two triangles matching the polygon and set the st attributes by hand, then use a Cesium.Material of type 'Image'.) There is no ready-made code snippet for this in Cesium’s docs, but the approach would be similar to Cesium’s “Custom Geometry & Appearances” tutorial: you supply a material that samples your image using the custom UVs
community.cesium.com
. If you’re comfortable with GLSL, a custom fragment shader could also warp a texture to four given corners. But this is a non-trivial, bespoke solution beyond Cesium’s standard API.

KML/3D Tiles pipeline. Some users generate KML (GroundOverlay) or glTF with the image texture. Google Earth’s KML overlay allows a georeferenced image on an arbitrary polygon, but Cesium’s KML importer currently maps that into a Cesium polygon (with the same UV issue). Exporting your geometry as a glTF model with texture UV-mapped correctly is another route, then loading it as a primitive or 3D Tiles. (Again, you’d compute the UVs in the model file.)

Canvas or 2D hacks. In theory one could use an HTML <canvas> to draw the image warped to the four corners and then use that canvas as a texture. For example, draw the image onto a canvas with a perspective transform (using Canvas2D or WebGL) so it matches your polygon, then use ImageMaterialProperty({image: myCanvas}). However, Cesium will still project that image onto the polygon’s bounding rectangle, so it won’t automatically “stick” to the four corners unless you use a custom shader on a Primitive.

Summary with examples

In summary: CesiumJS does not natively support directly stretching a single image to fit a 4-point polygon. The Entity/Geometry APIs either tile/crop images or lack the ability to set UVs
community.cesium.com
cesium.com
. The recommended Cesium approach is usually to use a SingleTileImageryProvider for an image covering a simple rectangle
cesium.com
cesium.com
. For truly arbitrary polygons, you must resort to custom solutions (custom primitives/shaders or external geometry).

For example, to overlay an image on a known rectangular region you could do:

viewer.imageryLayers.addImageryProvider(
  new Cesium.SingleTileImageryProvider({
    url: 'path/to/nature.jpg',
    rectangle: Cesium.Rectangle.fromDegrees(west, south, east, north)
  })
);


This will drape nature.jpg over that lat/lon box on the globe
cesium.com
. But for a general warped polygon, Cesium has no built-in one-step solution – the image will either clip or repeat. You would need to implement a custom mesh or shader if you absolutely need the image to deform with the four moving vertices
community.cesium.com
community.cesium.com
.

Sources: CesiumJS documentation and community discussions
community.cesium.com



