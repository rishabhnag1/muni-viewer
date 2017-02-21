
// Create the Visualization
var map = d3.select('#map');

// Read the width from the element and the height from the screen object
var width = map.node().clientWidth,
    height = screen.height;

// Create the SVG map
var svg = map
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    // Add zoom and pan
    .call(d3.zoom().on("zoom", function () {
      svg.attr("transform", "translate(" + d3.event.translate + ")" + " scale(" + d3.event.scale + ")")
    }))
    .append('g').attr('id', '#container');

var projection, path;

var counter = 0;

var routesCache, routeLookup;

var loaded = false;
var timeWindow = 15000;
var progress = 0;

var hiddenLayers = [],
    layers       = [];

var promises = {};

['streets', 'arteries', 'freeways', 'neighborhoods'].forEach(function (file){
  promises[file] = d3.promise.json('./maps/'+file+'.json');
});

// now load them in order
promises.streets.then(function (json){

  // Use the street dataset to workout the projection bounds
  workoutProjection(json);

  promises.neighborhoods
      .then(function (json2){
        appendPaths('neighborhoods', json2);
      }).then(function(){

    appendPaths('streets', json);

    return promises.arteries;
  }).then(function (json){

    appendPaths('arteries', json);

    return promises.freeways;

  }).then(function (json){

    appendPaths('freeways', json);

    // append an element to store the paths and the vehicles
    svg
        .append('g')
        .classed('paths', true);
    svg
        .append('g')
        .classed('routes', true);

    setupBusTracking();

    bindUI();
  });

});

function updateProgress(delta){
  progress += delta;
  // just in case
  progress = Math.min(100, progress);

  var completed = progress === 100;

  var el = d3
      .select('#progress-bar')
      .style('width', progress + '%')
      .text(!completed ? progress + '%' : 'Completed!');

  if(completed){
    // its a bit brutal but it's ok for now
    d3.select('#progress-data').transition().duration(1000).style('opacity', '0');
  }
}

function bindUI(){
  d3.selectAll('.layer-filter').on('click', doFiltering);

  var debounceKeyboard = debounce(onKeyUp, 50);

  d3.select('#routeId')
      .on('input', debounceKeyboard, false);
}


// Simple debounce function from
// http://stackoverflow.com/questions/9400615/whats-the-best-way-to-make-a-d3-js-visualisation-layout-responsive
function debounce(fn, timeout) {
  var timeoutID = -1;
  return function() {
    if (timeoutID > -1) {
      window.clearTimeout(timeoutID);
    }
    timeoutID = window.setTimeout(fn, timeout);
  };
}

function onKeyUp(){
  var text = d3.select('#routeId')[0][0].value || '';
  // clean the string
  var routes = text.toUpperCase().split(' ');
  // now create a lookup object
  var lookup = {};
  routes.forEach(function (route){
    lookup[route] = 1;
  });

  var any = routes.some(function (route){
    return route in routeLookup;
  });

  if( any ){
    // highlight the route here
    highlightLines(lookup);

  } else {
    restoreLines();
  }

}

function doFiltering(){
  var layer = d3.select(this).text().toLowerCase();
  // toggle the layer here
  if(hiddenLayers.indexOf(layer) > -1){
    // remove from the list
    hiddenLayers = hiddenLayers.filter(function (l){
      return l !== layer;
    });
  } else {
    hiddenLayers.push(layer);
  }
  filterLayer();
}

function filterLayer(){
  // for each layer
  layers.forEach(function (layerId){
    d3.select('#'+layerId).classed('hidden', function (){
      return hiddenLayers.indexOf(layerId) > -1;
    });
  });
}

function workoutProjection(geoJSON){
  var center = d3.geo.centroid(geoJSON);
  var scale  = 150;
  var offset = [width/2, height/2];
  projection = d3.geo.mercator().scale(scale).center(center)
      .translate(offset);

  // create the path
  path = d3.geo.path().projection(projection);

  // using the path determine the bounds of the current map and use
  // these to determine better values for the scale and translation
  var bounds  = path.bounds(geoJSON);
  var hscale  = scale*width  / (bounds[1][0] - bounds[0][0]);
  var vscale  = scale*height / (bounds[1][1] - bounds[0][1]);
  scale   = (hscale < vscale) ? hscale : vscale;
  offset  = [width - (bounds[0][0] + bounds[1][0])/2,
    height - (bounds[0][1] + bounds[1][1])/2];

  // new projection
  projection = d3.geo.mercator().center(center)
      .scale(scale).translate(offset);
  path = path.projection(projection);
}


function appendPaths(type, json){

  var track = svg
      .append('g').attr('id', type)
      .selectAll("path")
      .data(json.features)
      .enter()
      .append('path')
      .attr('d', path);

  layers.push(type);

  updateProgress(15);
}

function getVehiclePositions(time){

  var max = -Infinity,
      min = Infinity;
  var positions = [];

  return routesCache
      .map(function (route){
        return d3.promise.xml('http://webservices.nextbus.com/service/publicXMLFeed?command=vehicleLocations&a=sf-muni&r='+route.id+'&t='+(time || 0));
      }).reduce(function (chain, promise){
        return chain.then(function(){
          return promise;
        })
            .then(function (data){
              var linePos = getPositions(data);

              positions = positions.concat(linePos);

              var time = + d3.select(data).select('lastTime').attr('time');

              max = Math.max(max, time);
              min = Math.min(min, time);
            });
      }, Promise.resolve())
      .then(function(){

        return {avg: min + (max - min), positions: positions };
      });
}

function getPositions(data){
  var points = [];

  d3.select(data)
      .selectAll('vehicle')
      .each(function(){
        var vehicle = d3.select(this);

        points.push({
          type: 'Feature',
          properties:{
            id: vehicle.attr('id'),
            route: vehicle.attr('routeTag')
          },
          geometry:  {
            type: 'Point',
            coordinates: [ + vehicle.attr('lon'), + vehicle.attr('lat')]
          }
        });
      });

  return points;
}

function drawDots(geoJSON){

  // update elements as needed
  var dots = svg.select('g.routes').selectAll('g.routeDots')
      .data(geoJSON.features, function (d){ return d.properties.id; });

  // add new dots if needed
  dots.enter().append('g')
      .classed('routeDots', true)
      // Place them in the center, so that the animation to the specific point is nicer
      .attr('transform', function (d){
        return 'translate('+(width/2)+','+(height/2)+')';
      });

  // Now update the positions
  dots.transition('linear').duration(loaded ? timeWindow - 500 : 1000)
      .attr('transform', function (d){
        var projPos = projection(d.geometry.coordinates);
        return 'translate('+projPos[0]+','+projPos[1]+')';
      });

  // remove elements as needed
  // dots.exit().remove();

  if(!loaded){

    dots
        .append('circle')
        .attr('r', 7)
        .style('fill', function(d){
          return '#' + (routeLookup[d.properties.route] && routeLookup[d.properties.route].color || 'FFFFFF');
        });

    dots
        .append('text')
        .text(function(d){ return d.properties.route; });

    // Do not make people hover a 5px circle... bind the g element
    svg.selectAll('g.routeDots').on('mouseenter', function (d){
      var id = d.properties.id;
      var route = d.properties.route;
      svg.selectAll('g.routeDots').each(function (p){
        d3.select(this)
            .classed('active', p.properties.id === id)
            .classed('hidden', p.properties.id !== id);
      });
      svg.selectAll('g.paths path').classed('active', function (p){
        //match by route tag
        return p.id === route;
      });
    });

    svg.selectAll('g.routeDots circle').on('mouseleave', restoreLines);
  }
  loaded = true;

  return dots;
}

function highlightLines(lookup){
  svg.selectAll('g.routeDots').each(function (p){
    d3.select(this)
        .classed('active', p.properties.route in lookup)
        .classed('hidden', !(p.properties.route in lookup))
        .attr('r', p.properties.route in lookup ? 15 : 7);
  });
  svg.selectAll('g.paths path').classed('active', function (p){
    //match by route tag
    return p.id in lookup;
  });
}

function restoreLines(){
  // remove all highlights
  svg.selectAll('g.routeDots').classed('active hidden', false).attr('r', 7);
  svg.selectAll('g.paths path').classed('active', false);
}

function getRouteList(){
  return d3.promise
      .xml('http://webservices.nextbus.com/service/publicXMLFeed?command=routeList&a=sf-muni')
      .catch(function(){
        console.log(arguments);
      });
}

function getRoutePaths(){
  return d3.promise
      .xml('http://webservices.nextbus.com/service/publicXMLFeed?command=routeConfig&a=sf-muni')
      .catch(function(){
        console.log(arguments);
      });
}

function setupBusTracking(){

  var routesList = getRouteList();
  // This request does paging every 100 routes: sf muni has 84 lines so it should be fine
  var routesPaths = getRoutePaths();

  routesList
      .then(function (data){

        routesCache = getRoutes(data);

        routeLookup = {};

        routesCache.forEach(function (route){
          routeLookup[route.id] = route;
        });

        updateProgress(10);

        return routesPaths;
      })
      .then(function (data){

        doRoutesPaths(data);

        updateProgress(7);

        createRouteLegend();
        updateProgress(3);

        return getVehiclePositions();
      })
      .then(function (busInfo){

        updateProgress(30);

        updateMap(busInfo);
      });
}

function updateMap(busInfo){

  drawDots({type: 'FeatureCollection', features: busInfo.positions});

  setTimeout(function(){
    getVehiclePositions(busInfo.avg)
        .then(function (busInfo){
          updateMap(busInfo);
        });
  }, timeWindow);
}

function getRoutes(data){
  var routes = [];
  d3.select(data)
      .selectAll('route')
      .each(function(){
        var node = d3.select(this);
        routes.push({id: node.attr('tag'), name: node.attr('title') });
      });
  return routes;
}

function doRoutesPaths(data){
  var paths = [];

  d3.select(data)
      .selectAll('route')
      .each(function(){
        var pathLines = [];
        var node = d3.select(this);
        // get the color of the route
        var color = node.attr('color');
        var id    = node.attr('tag');

        routeLookup[id].color = color;

        // format the paths in something d3 can understand
        node
            .selectAll('path')
            .each(function(){
              var feature = [];

              d3.select(this).selectAll('point').each(function(){
                var point = d3.select(this);
                feature.push([ + point.attr('lon'), + point.attr('lat'), 0]);
              });

              pathLines.push({type: 'Feature', id: id, geometry: {type: 'LineString', coordinates: feature }});
            });

        paths.push({id: id, color: color, paths: pathLines});
        // now get all the paths for the given route
      });

  var pathLines = paths.map(function (route){
    return route.paths;
  }).reduce(function (features, paths){

    return features.concat(paths);

  }, []);

  svg.select('g.paths')
      .selectAll('path')
      .data(pathLines)
      .enter()
      .append('path')
      .attr('d', path)
      .style('stroke', function (d){ return '#'+routeLookup[d.id].color; });


  return paths;
}

function createRouteLegend(){
  var width = $( window ).width();
  var height = $( window ).height();

  var legend = d3.select('#legend').append('svg')
      .attr('width', width)
      .attr('height', height-180)
      .selectAll('g')
      .data(routesCache, function(d){ return d.id; })
      .enter()
      .append('g')
      .classed('legendDots', true)
      .attr('transform', function (_, i){
        // arrange the dots in a grid
        return 'translate('+(i%7 * 40 + 50)+','+(50 + 40 * Math.floor(i / 7))+')';
      })
      .on('mouseover', function (d){
        var dict = {};
        dict[d.id] = 1;
        highlightLines(dict);
      }).on('mouseleave', restoreLines);

  legend.append('circle')
      .attr('r', 30)
      .style('fill', function (d){
        return '#' + (routeLookup[d.id] && routeLookup[d.id].color || 'FFFFFF');
      });

  legend.append('text').text(function(d){ return d.id; });
}
