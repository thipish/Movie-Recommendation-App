import { NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase client
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export async function POST(request) {
  try {
    const { genre, language, additionalDetails, heroName, userId, savePreferences } = await request.json();
    console.log('Received request:', { genre, language, additionalDetails, heroName, userId, savePreferences });

    if (!genre) {
      return NextResponse.json({ error: 'Genre is required' }, { status: 400 });
    }

    // Save user preferences (Supabase part remains unchanged)
    if (savePreferences && userId) {
      try {
        const { error } = await supabase
          .from('user_preferences')
          .upsert(
            {
              user_id: userId,
              genre,
              language,
              additional_details: additionalDetails,
              updated_at: new Date().toISOString()
            },
            { onConflict: 'user_id' }
          );

        if (error) throw error;
      } catch (error) {
        console.error('Error saving preferences:', error);
      }
    }

    // TMDB API requests
    const tmdbApiKey = process.env.TMDB_API_KEY;
    if (!tmdbApiKey) {
      return NextResponse.json({ error: 'TMDB API key is not configured' }, { status: 500 });
    }

    // Delay and retry helpers
    function delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function fetchWithRetry(url, options, retries = 3) {
      for (let i = 0; i < retries; i++) {
        try {
          return await axios.get(url, options);
        } catch (error) {
          if (i === retries - 1) throw error;
          await delay(500);
        }
      }
    }

    // --- DIRECT MOVIE SEARCH ---
    console.log('Calling TMDB API for direct search based on criteria');
    
    // Combine ALL criteria (Hero Name, Genre, Details) into a single keyword search term
    const searchKeyword = `${heroName || ''} ${genre} ${additionalDetails || ''}`.trim();
    
    const searchResponse = await fetchWithRetry(
        `https://api.themoviedb.org/3/search/movie`,
        {
            params: {
                api_key: tmdbApiKey,
                query: searchKeyword, // Search using the combined text input
                language: language,
                page: 1,
                include_adult: false
            },
            timeout: 10000
        }
    );
    
    // Get up to 50 results
    const initialMovies = searchResponse.data.results || [];
    const validMovies = initialMovies.filter(movie => movie.title && movie.title.length > 0).slice(0, 50);

    if (validMovies.length === 0) {
      return NextResponse.json({
        error: 'No movies found matching your criteria',
        details: 'TMDB returned no valid results for the search'
      }, { status: 404 });
    }
    // --- END DIRECT MOVIE SEARCH ---

    // MODIFIED: Process enrichment SEQUENTIALLY to prevent Rate Limiting (ECONNRESET)
    const enrichedMovies = [];
    
    for (const movie of validMovies) {
        try {
            // Fetch full details for each movie (still needed for credits, runtime, genres)
            const detailsResponse = await axios.get(
                `https://api.themoviedb.org/3/movie/${movie.id}?api_key=${tmdbApiKey}&append_to_response=credits,videos,similar`
            );

            let providers = null;
            try {
                const providersResponse = await axios.get(
                    `https://api.themoviedb.org/3/movie/${movie.id}/watch/providers?api_key=${tmdbApiKey}`
                );
                providers = providersResponse.data.results?.US || null;
            } catch (e) {
                console.error('Error fetching providers:', e.message);
            }

            const movieData = {
                id: movie.id,
                title: movie.title,
                overview: movie.overview || 'No overview available',
                poster_path: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                backdrop_path: movie.backdrop_path ?
                    `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                release_date: movie.release_date ||
                    'Unknown',
                vote_average: movie.vote_average ||
                    0,
                vote_count: movie.vote_count ||
                    0,
                runtime: detailsResponse.data.runtime ||
                    0,
                genres: detailsResponse.data.genres ||
                    [],
                credits: detailsResponse.data.credits ||
                    { cast: [], crew: [] },
                videos: detailsResponse.data.videos?.results ||
                    [],
                similar: detailsResponse.data.similar?.results ||
                    [],
                providers,
                original_language: movie.original_language ||
                    'en',
                status: detailsResponse.data.status ||
                    'Unknown',
                tagline: detailsResponse.data.tagline ||
                    '',
            };
            if (userId) {
                try {
                    await supabase
                        .from('user_movies')
                        .upsert(
                            {
                                user_id: userId,
                                movie_id: movie.id,
                                movie_data: movieData,
                                genre: movieData.genres.map(g => g.name).join(', '),
                                language: movieData.original_language,
                                updated_at: new Date().toISOString()
                            },
                            { onConflict: 'user_id,movie_id' }
                        );
                } catch (error) {
                    console.error('Error saving movie to user preferences:', error.message);
                }
            }

            enrichedMovies.push(movieData);

        } catch (error) {
            console.error(`Error enriching details for ${movie.title}:`, error.message);
            // Push basic data if enrichment fails
            enrichedMovies.push({
                id: movie.id,
                title: movie.title,
                overview: movie.overview || 'No overview available',
                poster_path: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
                backdrop_path: movie.backdrop_path ? `https://image.tmdb.org/t/p/w1280${movie.backdrop_path}` : null,
                release_date: movie.release_date || 'Unknown',
                vote_average: movie.vote_average || 0,
                vote_count: movie.vote_count || 0,
                runtime: 0,
                genres: [],
                credits: { cast: [], crew: [] },
                videos: [],
                similar: [],
                providers: null,
                original_language: movie.original_language || 'en',
                status: 'Unknown',
                tagline: '',
            });
        }
        await delay(100); // Small enforced delay between requests
    }

    return NextResponse.json(enrichedMovies);
  } catch (error) {
    console.error('API route error:', error.message);
    return NextResponse.json({
      error: `API route error: ${error.message}`,
      details: 'Internal server error'
    }, { status: 500 });
  }
}

// Save movie list (helper function, remains unchanged)
async function saveMovieList(userId, listName, movies, searchCriteria) {
  try {
    const { data, error } = await supabase
      .from('movie_lists')
      .insert([{
        user_id: userId,
        name: listName,
        genre: searchCriteria.genre,
        language: searchCriteria.language,
        additional_details: searchCriteria.additionalDetails,
        movies: movies,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    return data[0];
  } catch (error) {
    console.error('Error saving movie list:', error.message);
    throw error;
  }
}