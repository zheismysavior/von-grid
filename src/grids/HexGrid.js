/*
	Graph of hexagons. Handles grid cell management (placement math for eg pathfinding, range, etc) and grid conversion math.
	[Cube/axial coordinate system](http://www.redblobgames.com/grids/hexagons/), "flat top" version only. Since this is 3D, just rotate your camera for pointy top maps.
	Interface:
	type
	size - number of cells (in radius); only used if the map is generated
	cellSize
	cellSides
	cells - a hash so we can have sparse maps
	numCells
	extrudeSettings
	autogenerated
	cellShape
	cellGeo
	cellShapeGeo

	@author Corey Birnbaum https://github.com/vonWolfehaus/
 */
// 'utils/Loader', 'graphs/Hex', 'utils/Tools'
vg.HexGrid = function(config) {
	if (!config) config = {};
	var gridSettings = {
		rings: 5, // creates a hexagon-shaped grid of this size
		cellSize: 10, // radius of the hex
		url: null, // loads in map JSON data for arbitrary/sparse maps created with the editor
	};

	gridSettings = vg.Tools.merge(gridSettings, config);

	/*  ______________________________________________
		GRID INTERFACE:

	*/
	this.type = vg.HEX;
	this.size = gridSettings.rings;
	this.cellSize = gridSettings.cellSize;
	this.cellSides = 6;
	this.cells = {};
	this.numCells = 0;

	this.extrudeSettings = null;
	this.autogenerated = false;

	// create base shape used for building geometry
	var i, verts = [];
	// create the skeleton of the hex
	for (i = 0; i < 6; i++) {
		verts.push(this._createVertex(i));
	}
	// copy the verts into a shape for the geometry to use
	this.cellShape = new THREE.Shape();
	this.cellShape.moveTo(verts[0].x, verts[0].y);
	for (i = 1; i < 6; i++) {
		this.cellShape.lineTo(verts[i].x, verts[i].y);
	}
	this.cellShape.lineTo(verts[0].x, verts[0].y);

	this.cellGeo = new THREE.Geometry();
	this.cellGeo.vertices = verts;
	this.cellGeo.verticesNeedUpdate = true;

	this.cellShapeGeo = new THREE.ShapeGeometry(this.cellShape);

	/*  ______________________________________________
		PRIVATE
	*/

	this._cellWidth = this.cellSize * 2;
	this._cellLength = (vg.SQRT3 * 0.5) * this._cellWidth;
	this._hashDelimeter = '.';
	// pre-computed permutations
	this._directions = [new vg.Cell(+1, -1, 0), new vg.Cell(+1, 0, -1), new vg.Cell(0, +1, -1),
						new vg.Cell(-1, +1, 0), new vg.Cell(-1, 0, +1), new vg.Cell(0, -1, +1)];
	this._diagonals = [new vg.Cell(+2, -1, -1), new vg.Cell(+1, +1, -2), new vg.Cell(-1, +2, -1),
					   new vg.Cell(-2, +1, +1), new vg.Cell(-1, -1, +2), new vg.Cell(+1, -2, +1)];
	// cached objects
	this._list = [];
	this._vec3 = new THREE.Vector3();
	this._cel = new vg.Cell();
	this._conversionVec = new THREE.Vector3();
	this._geoCache = [];
	this._matCache = [];

	// build the grid depending on what was passed in
	if (gridSettings.url) {
		vg.Tools.getJSON(gridSettings.url, this.load, this);
	}
	else {
		this.generate();
	}
};

vg.HexGrid.TWO_THIRDS = 2 / 3;

vg.HexGrid.prototype = {
	/*
		________________________________________________________________________
		High-level functions that the Board interfaces with (all grids implement)
	 */

	// grid cell (Hex in cube coordinate space) to position in pixels/world
	cellToPixel: function(cell) {
		this._vec3.x = cell.q * this._cellWidth * 0.75;
		this._vec3.y = cell.h;
		this._vec3.z = (cell.s - cell.r) * this._cellLength * 0.5;
		return this._vec3;
	},

	pixelToCell: function(pos) {
		// convert a position in world space ("pixels") to cell coordinates
		var q = pos.x * (vg.HexGrid.TWO_THIRDS / this.cellSize);
		var r = ((-pos.x / 3) + (vg.SQRT3/3) * pos.y) / this.cellSize;
		this._cel.set(q, r, -q-r);
		return this._cubeRound(this._cel);
	},

	getCellAt: function(pos) {
		// get the Cell (if any) at the passed world position
		var q = pos.x * (vg.HexGrid.TWO_THIRDS / this.cellSize);
		var r = ((-pos.x / 3) + (vg.SQRT3/3) * pos.y) / this.cellSize;
		this._cel.set(q, r, -q-r);
		this._cubeRound(this._cel);
		return this.cells[this.cellToHash(this._cel)];
	},

	getNeighbors: function(cell, diagonal, filter) {
		// always returns an array
		var i, n, l = this._directions.length;
		this._list.length = 0;
		for (i = 0; i < l; i++) {
			this._cel.copy(cell);
			this._cel.add(this._directions[i]);
			n = this.cells[this.cellToHash(this._cel)];
			if (!n || (filter && !filter(cell, n))) {
				continue;
			}
			this._list.push(n);
		}
		if (diagonal) {
			for (i = 0; i < l; i++) {
				this._cel.copy(cell);
				this._cel.add(this._diagonals[i]);
				n = this.cells[this.cellToHash(this._cel)];
				if (!n || (filter && !filter(cell, n))) {
					continue;
				}
				this._list.push(n);
			}
		}
		return this._list;
	},

	getRandomCell: function() {
		var c, i = 0, x = vg.Tools.randomInt(0, this.numCells);
		for (c in this.cells) {
			if (i === x) {
				return this.cells[c];
			}
			i++;
		}
		return this.cells[c];
	},

	cellToHash: function(cell) {
		return cell.q+this._hashDelimeter+cell.r+this._hashDelimeter+cell.s;
	},

	distance: function(cellA, cellB) {
		var d = Math.max(Math.abs(cellA.q - cellB.q), Math.abs(cellA.r - cellB.r), Math.abs(cellA.s - cellB.s));
		d += cellB.h - cellA.h; // include vertical height
		return d;
	},

	clearPath: function() {
		var i, c;
		for (i in this.cells) {
			c = this.cells[i];
			c._calcCost = 0;
			c._priority = 0;
			c._parent = null;
			c._visited = false;
		}
	},

	traverse: function(cb) {
		var i;
		for (i in this.cells) {
			cb(this.cells[i]);
		}
	},

	generateTile: function(cell, scale, material) {
		var height = Math.abs(cell.h);
		if (height < 1) height = 1;

		var geo = this._geoCache[height];
		if (!geo) {
			this.extrudeSettings.amount = height;
			geo = new THREE.ExtrudeGeometry(this.cellShape, this.extrudeSettings);
			this._geoCache[height] = geo;
		}

		/*mat = this._matCache[c.matConfig.mat_cache_id];
		if (!mat) { // MaterialLoader? we currently only support basic stuff though. maybe later
			mat.map = Loader.loadTexture(c.matConfig.imgURL);
			delete c.matConfig.imgURL;
			mat = new THREE[c.matConfig.type](c.matConfig);
			this._matCache[c.matConfig.mat_cache_id] = mat;
		}*/

		var hex = new vg.Tile({
			size: this.cellSize,
			scale: scale,
			cell: cell,
			geometry: geo,
			material: material
		});

		cell.tile = hex;

		return hex;
	},

	generateTiles: function(config) {
		config = config || {};
		var tiles = [];
		var settings = {
			scale: 0.95,
			cellSize: this.cellSize,
			material: null,
			extrudeSettings: {
				amount: 1,
				bevelEnabled: true,
				bevelSegments: 1,
				steps: 1,
				bevelSize: 0.5,
				bevelThickness: 0.5
			}
		}
		settings = vg.Tools.merge(settings, config);

		/*if (!settings.material) {
			settings.material = new THREE.MeshPhongMaterial({
				color: vg.Tools.randomizeRGB('30, 30, 30', 10)
			});
		}*/

		// overwrite with any new dimensions
		this.cellSize = settings.cellSize;
		this._cellWidth = this.cellSize * 2;
		this._cellLength = (vg.SQRT3 * 0.5) * this._cellWidth;

		this.autogenerated = true;
		this.extrudeSettings = settings.extrudeSettings;
		// console.log(this.cells);

		var i, t, c;
		for (i in this.cells) {
			c = this.cells[i];
			c.h = settings.extrudeSettings.amount;
			t = this.generateTile(c, settings.scale, settings.material);
			t.position.copy(this.cellToPixel(c));
			t.position.y = 0;
			tiles.push(t);
		}
		return tiles;
	},

	generateTilePoly: function(material) {
		if (!material) {
			material = new THREE.MeshBasicMaterial({color: 0x24b4ff});
		}
		var mesh = new THREE.Mesh(this.cellShapeGeo, material);
		this._vec3.set(1, 0, 0);
		mesh.rotateOnAxis(this._vec3, vg.PI/2);
		return mesh;
	},

	// create a flat, hexagon-shaped grid
	generate: function() {
		var x, y, z, c;
		for (x = -this.size; x < this.size+1; x++) {
			for (y = -this.size; y < this.size+1; y++) {
				z = -x-y;
				if (Math.abs(x) <= this.size && Math.abs(y) <= this.size && Math.abs(z) <= this.size) {
					c = new vg.Cell(x, y, z);
					this.add(c);
				}
			}
		}
	},

	generateOverlay: function(size, overlayObj, overlayMat) {
		var x, y, z;
		for (x = -size; x < size+1; x++) {
			for (y = -size; y < size+1; y++) {
				z = -x-y;
				if (Math.abs(x) <= size && Math.abs(y) <= size && Math.abs(z) <= size) {
					this._cel.set(x, y, z); // define the cell
					var line = new THREE.Line(this.cellGeo, overlayMat);
					this.setPositionToCell(line.position, this._cel);
					line.rotation.x = 90 * vg.DEG_TO_RAD;
					overlayObj.add(line);
				}
			}
		}
	},

	add: function(cell) {
		var h = this.cellToHash(cell);
		if (this.cells[h]) {
			// console.warn('A cell already exists there');
			return;
		}
		this.cells[h] = cell;
		this.numCells++;

		return cell;
	},

	remove: function(cell) {
		var h = this.cellToHash(cell);
		if (this.cells[h]) {
			delete this.cells[h];
			this.numCells--;
		}
	},

	dispose: function() {
		this.cells = null;
		this.numCells = 0;
		this.cellShape = null;
		this.cellGeo.dispose();
		this.cellGeo = null;
		this.cellShapeGeo.dispose();
		this.cellShapeGeo = null;
		this._list = null;
		this._vec3 = null;
		this._conversionVec = null;
		this._geoCache = null;
		this._matCache = null;
	},

	/*
		Load a grid from a parsed json object.
		json = {
			extrudeSettings,
			size,
			cellSize,
			autogenerated,
			cells: [],
			materials: [
				{
					cache_id: 0,
					type: 'MeshLambertMaterial',
					color, ambient, emissive, reflectivity, refractionRatio, wrapAround,
					imgURL: url
				},
				{
					cacheId: 1, ...
				}
				...
			]
		}
	*/
	load: function(json) {
		var i, c;
		var cells = json.cells;

		this.cells = {};
		this.numCells = 0;

		this.size = json.size;
		this.cellSize = json.cellSize;
		this.extrudeSettings = json.extrudeSettings;
		this.autogenerated = json.autogenerated;

		// create Hex instances and place them on the grid, and add them to the group for easy management
		for (i = 0; i < cells.length; i++) {
			c = new vg.Cell();
			c.copy(cells[i]);
			this.add(c);
		}
		// console.log(this.cells);
	},

	toJSON: function() {
		var json = {
			size: this.size,
			cellSize: this.cellSize,
			extrudeSettings: this.extrudeSettings,
			autogenerated: this.autogenerated
		};
		var cells = [];
		var c, k;

		for (k in this.cells) {
			c = this.cells[k];
			cells.push({
				q: c.q,
				r: c.r,
				s: c.s,
				h: c.h,
				walkable: c.walkable,
				userData: c.userData
			});
		}
		json.cells = cells;

		return json;
	},

	/*  ________________________________________________________________________
		Hexagon-specific conversion math
		Mostly commented out because they're inlined whenever possible to increase performance.
		They're still here for reference.
	 */

	_createVertex: function(i) {
		var angle = (vg.TAU / 6) * i;
		return new THREE.Vector3((this.cellSize * Math.cos(angle)), (this.cellSize * Math.sin(angle)), 0);
	},

	/*_pixelToAxial: function(pos) {
		var q, r; // = x, y
		q = pos.x * ((2/3) / this.cellSize);
		r = ((-pos.x / 3) + (vg.SQRT3/3) * pos.y) / this.cellSize;
		this._cel.set(q, r, -q-r);
		return this._cubeRound(this._cel);
	},*/

	/*_axialToCube: function(h) {
		return {
			q: h.q,
			r: h.r,
			s: -h.q - h.r
		};
	},*/

	/*_cubeToAxial: function(cell) {
		return cell; // yep
	},*/

	/*_axialToPixel: function(cell) {
		var x, y; // = q, r
		x = cell.q * this._cellWidth * 0.75;
		y = (cell.s - cell.r) * this._cellLength * 0.5;
		return {x: x, y: -y};
	},*/

	/*_hexToPixel: function(h) {
		var x, y; // = q, r
		x = this.cellSize * 1.5 * h.x;
		y = this.cellSize * vg.SQRT3 * (h.y + (h.x * 0.5));
		return {x: x, y: y};
	},*/

	/*_axialRound: function(h) {
		return this._cubeRound(this.axialToCube(h));
	},*/

	_cubeRound: function(h) {
		var rx = Math.round(h.q);
		var ry = Math.round(h.r);
		var rz = Math.round(h.s);

		var xDiff = Math.abs(rx - h.q);
		var yDiff = Math.abs(ry - h.r);
		var zDiff = Math.abs(rz - h.s);

		if (xDiff > yDiff && xDiff > zDiff) {
			rx = -ry-rz;
		}
		else if (yDiff > zDiff) {
			ry = -rx-rz;
		}
		else {
			rz = -rx-ry;
		}

		return this._cel.set(rx, ry, rz);
	},

	/*_cubeDistance: function(a, b) {
		return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.s - b.s));
	}*/
};

vg.HexGrid.prototype.constructor = vg.HexGrid;
